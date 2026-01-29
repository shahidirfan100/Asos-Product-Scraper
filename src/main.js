// ASOS Product Scraper - robust SSR window.asos extractor (Cheerio + sandboxed JS eval)
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { HeaderGenerator } from 'header-generator';
import vm from 'node:vm';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    keyword = 'men',
    startUrl,
    minPrice,
    maxPrice,
    sortBy = 'pricedesc',
    results_wanted: resultsWantedRaw = 20,
    proxyConfiguration: proxyInput,
} = input;

const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 20;

log.info(`Starting ASOS scraper for keyword: "${keyword}", results wanted: ${resultsWanted}`);

const headerGenerator = new HeaderGenerator({
    browsers: [{ name: 'chrome', minVersion: 120, httpVersion: '2' }],
    devices: ['desktop'],
    operatingSystems: ['windows'],
    locales: ['en-US'],
});

const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput || { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
);

const buildSearchUrl = (page = 1) => {
    const url = new URL('https://www.asos.com/search/');
    url.searchParams.set('q', keyword);
    url.searchParams.set('page', String(page));
    if (sortBy) url.searchParams.set('sort', sortBy);
    return url.toString();
};

const seenIds = new Set();
let saved = 0;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 80,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxUsageCount: 10 } },
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
        async ({ request }) => {
            const headers = headerGenerator.getHeaders();
            request.headers = { ...headers, ...request.headers };
        },
    ],
    async requestHandler({ $, request, body, crawler: crawlerInstance }) {
        const html = body?.toString?.() || '';
        log.info(`Processing: ${request.url}`);

        // Prefer server-rendered data: window.asos -> __NEXT_DATA__ fallback
        const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
        log.info(`Page title: ${title}`);

        const windowAsos = extractWindowAsos(html);
        let products = getProductsFromWindow(windowAsos);

        if (!products.length) {
            const nextData = extractNextData(html);
            products = getProductsFromWindow(nextData);
        }

        // Fallback: DOM Parsing
        if (!products.length) {
            products = parseDomProducts(html, $);
            if (products.length) log.info(`Recovered ${products.length} products via DOM parsing`);
        }

        if (!products.length) {
            log.warning(`No products found on ${request.url}`);

            // Save to local file (if running locally)
            try {
                const fs = await import('fs/promises');
                await fs.writeFile('debug.html', html);
            } catch (e) { }

            // Save to Apify Key-Value Store (visible in platform)
            await Actor.setValue('DEBUG_HTML', html, { contentType: 'text/html' });
            log.info('Saved HTML to Key-Value Store "DEBUG_HTML" for inspection');

            return;
        }

        const filtered = products.filter((p) => pricePasses(p.price, minPrice, maxPrice));
        const pagination = extractPagination(windowAsos) || extractPaginationFromUrl(request.url);

        for (const product of filtered) {
            if (saved >= resultsWanted) break;
            const normalized = normalizeProduct(product);
            if (!normalized.id || seenIds.has(normalized.id)) continue;
            seenIds.add(normalized.id);
            await Dataset.pushData({ ...normalized, source_url: request.url });
            saved++;
        }

        log.info(`Saved ${saved}/${resultsWanted} products so far.`);

        if (saved >= resultsWanted) return;

        const nextUrl = nextPageUrl(request.url, pagination, products.length);
        if (nextUrl) {
            log.info(`Enqueueing next page: ${nextUrl}`);
            await crawlerInstance.addRequests([{ url: nextUrl }]);
        }
    },
});

await crawler.run([startUrl || buildSearchUrl(1)]);

log.info('Crawl finished.');
await Actor.exit();

function extractWindowAsos(html) {
    // 1) Structured JSON payloads: <script data-id="window.asos..." type="application/json">{...}</script>
    const dataIdRegex = /<script[^>]*data-id="window\.asos[^"]*"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = dataIdRegex.exec(html)) !== null) {
        const json = match[1]?.trim();
        const parsed = parseJsonSafe(json);
        if (parsed) return parsed;
    }

    // 2) Inline assignment: window.asos = {...}; (minified). Evaluate in vm but only after isolating the object literal
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = scriptRegex.exec(html)) !== null) {
        const script = match[1];
        if (!script || !script.includes('window.asos')) continue;

        // Extract JSON substring after first equals
        const assignMatch = script.match(/window\.asos\s*=\s*(\{[\s\S]*?\});?/);
        if (assignMatch?.[1]) {
            const parsed = parseJsonSafe(assignMatch[1]);
            if (parsed) return parsed;
        }

        // Fallback: evaluate inside sandbox
        const context = {
            result: null,
            document: {},
            navigator: {},
            location: {},
            localStorage: { getItem: () => null, setItem: () => undefined },
        };

        const code = `var window = { asos: {} };
            ${script}
            globalThis.result = window.asos;`;

        try {
            vm.runInNewContext(code, context, { timeout: 500 });
            if (context.result && Object.keys(context.result).length) return context.result;
        } catch (error) {
            log.debug(`window.asos eval failed: ${error.message}`);
        }
    }
    return null;
}

function extractNextData(html) {
    const match = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;
    try {
        return JSON.parse(match[1]);
    } catch (error) {
        log.debug(`__NEXT_DATA__ parse failed: ${error.message}`);
        return null;
    }
}

function getProductsFromWindow(data) {
    if (!data) return [];
    return (
        data.plp?.products ||
        data.plp?.results ||
        data.search?.products ||
        data.search?.results ||
        data.props?.pageProps?.searchResults?.products ||
        data.props?.pageProps?.plp?.products ||
        data.products ||
        []
    );
}

function extractPagination(obj) {
    const p = obj?.plp?.pagination || obj?.pagination;
    if (!p) return null;
    return {
        page: Number(p.pageNumber ?? p.page ?? p.currentPage ?? 1),
        pageSize: Number(p.pageSize ?? p.itemsPerPage ?? p.perPage ?? p.limit ?? 72),
        totalPages: Number(p.totalPages ?? p.numberOfPages ?? p.pages ?? 0) || null,
        totalResults: Number(p.totalResults ?? p.resultCount ?? p.total ?? 0) || null,
    };
}

function extractPaginationFromUrl(url) {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') || 1);
    return { page, pageSize: null, totalPages: null, totalResults: null };
}

function nextPageUrl(currentUrl, pageInfo, productsOnPage) {
    if (!productsOnPage) return null;
    const urlObj = new URL(currentUrl);
    const currentPage = pageInfo?.page || Number(urlObj.searchParams.get('page') || 1);
    const totalPages = pageInfo?.totalPages;
    if (totalPages && currentPage >= totalPages) return null;

    urlObj.searchParams.set('page', String(currentPage + 1));
    return urlObj.toString();
}

function pricePasses(priceObj, min, max) {
    const value = extractPriceValue(priceObj);
    if (min != null && value != null && value < min) return false;
    if (max != null && value != null && value > max) return false;
    return true;
}

function extractPriceValue(price) {
    if (!price) return null;
    const direct = price.current?.value ?? price.current?.price ?? price.value;
    if (Number.isFinite(direct)) return direct;
    return parsePriceText(price.current?.text || price.text);
}

function parsePriceText(text) {
    if (!text) return null;
    const match = text.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
    return match ? Number(match[1]) : null;
}

function normalizeImageUrl(url) {
    if (!url) return null;
    let clean = url.trim();
    if (clean.startsWith('//')) clean = `https:${clean}`;
    if (!clean.startsWith('http')) clean = `https://images.asos-media.com/products/${clean}`;
    return clean.split('?')[0];
}

function normalizeProduct(p) {
    const id = String(p.id ?? p.productId ?? p.productid ?? p.product?.id ?? '');
    const urlPath = p.url || p.productUrl || p.webUrl || null;
    const productUrl = urlPath?.startsWith('http') ? urlPath : urlPath ? `https://www.asos.com${urlPath}` : null;
    const currentPrice = extractPriceValue(p.price) ?? null;
    const originalPrice = p.price?.previous?.value ?? p.price?.was?.value ?? p.price?.rrp?.value ?? null;

    return {
        id,
        title: p.name || p.title || p.productTitle || null,
        brand: p.brandName || p.brand?.name || null,
        currency: p.price?.currency || p.price?.current?.symbol || null,
        price_value: currentPrice,
        price_text: p.price?.current?.text || (currentPrice != null ? String(currentPrice) : null),
        original_price_value: originalPrice,
        is_marked_down: Boolean(p.price?.isMarkedDown || (originalPrice && currentPrice && originalPrice > currentPrice)),
        is_in_stock: p.isNoSize ? false : p.isInStock ?? true,
        url: productUrl,
        image_url: normalizeImageUrl(p.imageUrl || p.images?.[0]?.url || p.media?.images?.[0]?.url || null),
        color: p.colour || p.colourWayLabel || null,
        badge: p.badges?.[0]?.text || p.productType || null,
    };
}

function parseJsonSafe(str) {
    if (!str) return null;
    try {
        return JSON.parse(str);
    } catch {
        // Sometimes HTML entities break parsing; try a relaxed cleanup
        const cleaned = str.replace(/&quot;/g, '"');
        try {
            return JSON.parse(cleaned);
        } catch {
            return null;
        }
    }
}

function parseDomProducts(html, $) {
    const products = [];
    // Selectors based on browser investigation
    const tiles = $('article, [data-testid="productTile"], li[class*="productTile"]');

    tiles.each((i, el) => {
        try {
            const tile = $(el);
            const link = tile.find('a[class*="productLink"]').first();
            const href = link.attr('href');
            if (!href) return;

            const idMatch = href.match(/\/prd\/(\d+)/i) || href.match(/\/grp\/(\d+)/i);
            const id = idMatch ? idMatch[1] : `dom-${i}`;

            // Image
            const img = tile.find('img').first();
            const imageUrl = img.attr('src');

            // Metadata from aria-label on info div is very rich
            const infoDiv = tile.find('[class*="productInfo"]');
            const ariaLabel = infoDiv.attr('aria-label') || link.attr('title') || '';

            // Extract prices
            let priceVal = null;
            let origPriceVal = null;
            const priceText = tile.find('[data-testid="current-price"]').text() || tile.text();

            if (ariaLabel) {
                // "Original price $124.75 current price $106.65"
                const currentMatch = ariaLabel.match(/current price\s*([$£€]?\d+(?:\.\d+)?)/i);
                const originalMatch = ariaLabel.match(/Original price\s*([$£€]?\d+(?:\.\d+)?)/i);
                if (currentMatch) priceVal = parsePriceText(currentMatch[1]);
                if (originalMatch) origPriceVal = parsePriceText(originalMatch[1]);
            }

            if (!priceVal) {
                // Fallback to text parsing
                priceVal = parsePriceText(priceText);
            }

            // Title
            const title = tile.find('p[class*="productDescription"]').text() ||
                img.attr('alt') ||
                ariaLabel.split(',')[0] ||
                'Unknown Product';

            products.push({
                id,
                name: title,
                url: href,
                imageUrl,
                price: {
                    current: { value: priceVal, text: priceText },
                    previous: { value: origPriceVal }
                },
                brandName: null, // Hard to get from DOM reliably without classes
                isMarkedDown: !!origPriceVal
            });
        } catch (e) {
            // Ignore single failures
        }
    });

    return products;
}
