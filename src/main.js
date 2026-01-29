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

const productBuffer = [];
const BATCH_SIZE = 10;

async function pushBufferedData(force = false) {
    if (productBuffer.length >= BATCH_SIZE || (force && productBuffer.length > 0)) {
        await Dataset.pushData(productBuffer);
        log.info(`Flushed ${productBuffer.length} products to dataset.`);
        productBuffer.length = 0;
    }
}

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
        const { label } = request.userData;

        if (label === 'DETAIL') {
            await handleDetail($, request, body);
            return;
        }

        const html = body?.toString?.() || '';
        log.info(`Processing listing: ${request.url}`);

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
            // Save to Apify Key-Value Store (visible in platform)
            await Actor.setValue('DEBUG_HTML_LISTING', html, { contentType: 'text/html' });
            return;
        }

        // Filter and Enqueue Detail Pages
        const filtered = products.filter((p) => pricePasses(p.price, minPrice, maxPrice));

        for (const p of filtered) {
            if (saved >= resultsWanted) break;

            // We need a unique ID to dedup. 
            // If we have a robust ID from listing, use it. Otherwise url is key.
            const id = String(p.id || p.productId || '');
            if (id && seenIds.has(id)) continue;
            if (id) seenIds.add(id);

            let productUrl = p.url || p.productUrl;
            if (productUrl && !productUrl.startsWith('http')) {
                productUrl = `https://www.asos.com${productUrl}`;
            }

            if (productUrl) {
                log.debug(`Enqueueing detail: ${productUrl}`);
                await crawlerInstance.addRequests([{
                    url: productUrl,
                    userData: { label: 'DETAIL', listingProduct: p } // Pass listing data as backup
                }]);
            }
        }

        // Listing Pagination
        // Only if we haven't reached the limit (checked at save time usually, but here we enqueue detail pages)
        // We'll check 'saved' increment inside handleDetail ideally, but since we are async, 
        // we might over-crawl slightly. better to check globally or estimate.
        if (saved < resultsWanted) {
            const pagination = extractPagination(windowAsos) || extractPaginationFromUrl(request.url);
            const nextUrl = nextPageUrl(request.url, pagination, products.length);
            if (nextUrl) {
                log.info(`Enqueueing next page: ${nextUrl}`);
                await crawlerInstance.addRequests([{ url: nextUrl }]);
            }
        }
    },
});

await crawler.run([startUrl || buildSearchUrl(1)]);

log.info('Crawl finished.');
await pushBufferedData(true);
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

function infoDivAttr(tile, link, attr) {
    return tile.find('[class*="productInfo"]').attr(attr) || link.attr(attr) || '';
}

function parseDomProducts(html, $) {
    const products = [];
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
            // Try explicit image selector first, then fallback
            const img = tile.find('img[class*="productImage"], img').first();
            let imageUrl = img.attr('src');
            // Ensure high-res or clean URL
            if (imageUrl) {
                // Remove width params to get cleaner image
                imageUrl = imageUrl.split('?')[0];
            }

            // Title & Brand
            // Description often contains both Brand + Title or just Title
            const descriptionText = tile.find('p[class*="productDescription"]').text().trim();
            const ariaLabel = infoDivAttr(tile, link, 'aria-label');

            // Extracting Brand is hard without specific classes, but often ASOS titles start with Brand
            // For now, we leave Brand null unless we find a specific element or pattern
            // Some ASOS tiles have a 'div[class*="brandName"]' or similar hidden? Not in recent scans.
            // We will refine Title to remove Price if it leaked in.

            // Prices
            // Robust extraction from aria-label or text
            // Text is often "£34.00" or "£34.00\nWas £40.00"
            const priceSection = tile.find('span[class*="price"]').first().parent(); // Often container
            const currentPriceText = tile.find('span[data-testid="current-price"]').text() ||
                tile.find('span[class*="saleAmount"]').text() ||
                tile.find('span[class*="price"]').first().text();

            let priceVal = parsePriceText(currentPriceText);

            // Aria-label is usually "Title, current price $XX, original price $YY"
            // We can re-parse title from aria-label if description is empty, splitting by 'current price'
            let title = descriptionText;
            if (!title && ariaLabel) {
                title = ariaLabel.split(/current price|Original price/i)[0].replace(/,$/, '').trim();
            }

            // Clean title if it contains price (Edge case reported by user)
            // e.g. "Hoodie... £34.00" -> remove price part if present at end
            if (title && priceVal) {
                // specific check if title ENDS with price-like text
                title = title.replace(/\s*£\d+\.\d+.*$/, '').trim();
            }

            // Currency
            let currency = null;
            if (currentPriceText) {
                const currencyMatch = currentPriceText.match(/[$£€]/);
                if (currencyMatch) currency = currencyMatch[0];
            }

            // Badge / Product Type
            // Often in a 'div[class*="sellingFast"]' or similar overlay
            const badge = tile.find('div[class*="sellingFast"], span[class*="overlay"]').text().trim() || null;

            products.push({
                id,
                name: title,
                url: href,
                imageUrl,
                price: {
                    current: { value: priceVal, text: currentPriceText },
                    previous: { value: null } // Hard to extract reliably from mixed DOM without clear selectors
                },
                brandName: null, // Without explicit brand field, better null than wrong
                isMarkedDown: false,
                currency: currency,
                badge: badge
            });
        } catch (e) {
            // Ignore (log.debug(e.message) if needed)
        }
    });

    return products;
}



async function handleDetail($, request, body) {
    const html = body?.toString?.() || '';
    if (saved >= resultsWanted) return;

    // 1. Try window.asos
    let windowAsos = extractWindowAsos(html);
    let pdp = windowAsos?.pdp;

    // 2. Try __NEXT_DATA__ if window.asos is missing (Layout difference)
    if (!pdp) {
        const nextData = extractNextData(html);
        if (nextData?.props?.pageProps?.initialStoreConfig) {
            // Sometimes data is here, but often specific product data is deep
            // In Next.js ASOS, often verify: nextData.props.pageProps.product
            pdp = { product: nextData.props.pageProps.product, config: nextData.props.pageProps };
        }
    }

    // Backup: Listing data passed via userData
    const listingProduct = request.userData.listingProduct || {};

    // Fallback variables
    let item = null;

    if (pdp && (pdp.product || pdp.config?.product)) {
        try {
            const p = pdp.config?.product || pdp.product || {};
            const config = pdp.config || {};

            // Resolving Price
            let priceData = null;
            if (config.stockPriceResponse) {
                try {
                    const stockPrice = JSON.parse(config.stockPriceResponse);
                    if (Array.isArray(stockPrice)) priceData = stockPrice[0]?.productPrice;
                } catch (e) { }
            }
            if (!priceData) priceData = p.price;

            const variants = p.variants || [];
            const firstVariant = variants[0] || {};

            const id = String(p.id || p.productCode || listingProduct.id || '');
            const title = p.name || listingProduct.title;
            const brand = p.brandName || listingProduct.brand;
            const images = p.images || [];
            const imageUrl = images[0]?.url ? normalizeImageUrl(images[0].url) : normalizeImageUrl(listingProduct.imageUrl);

            const sizes = variants.map(v => ({
                id: v.variantId,
                name: v.size,
                is_in_stock: v.isInStock,
                sku: v.sku
            }));

            const currency = priceData?.currency || config.currency || 'GBP';
            const currentPriceVal = priceData?.current?.value ?? listingProduct.price_value;
            const previousPriceVal = priceData?.previous?.value || priceData?.rrp?.value || listingProduct.original_price_value;

            const color = firstVariant.colour || p.colour || listingProduct.color;

            let badge = null;
            if (p.badges && p.badges.length > 0) {
                badge = p.badges.map(b => b.label || b.text).join(', ');
            } else {
                badge = listingProduct.badge;
            }

            const isMarkedDown = p.isMarkedDown || (previousPriceVal && currentPriceVal && previousPriceVal > currentPriceVal) || listingProduct.is_marked_down;

            item = {
                id,
                title,
                url: request.url,
                brand,
                color,
                price_current: currentPriceVal,
                price_previous: previousPriceVal,
                currency,
                is_marked_down: isMarkedDown,
                is_in_stock: p.isInStock ?? (sizes.length ? sizes.some(s => s.is_in_stock) : listingProduct.is_in_stock),
                stock_status: sizes.map(s => `${s.name}: ${s.is_in_stock ? 'In Stock' : 'Out of Stock'}`),
                image_url: imageUrl,
                badge,
                gender: p.gender,
                sizes,
                description: null, // Will fetch below
                delivery_info: null // Will fetch below
            };
        } catch (e) {
            log.debug(`JSON extraction error on ${request.url}: ${e.message}`);
        }
    }

    // fallback to DOM if we have partial or no item
    // Or if we want to enrich specific fields like description which are often DOM-only
    if (!item) {
        // Construct from Listing Product + DOM Fallback
        item = { ...listingProduct, url: request.url };
        // Try to scrape basic details from DOM if JSON failed entirely
        // (You can expand this if needed, but listingProduct is a good baseline)
    }

    // Always try to enrich with DOM for Description/Delivery if missing
    // Selector: #productDescription
    if (!item.description) {
        let productDetails = $('#productDescription').text().trim();
        if (productDetails) item.description = productDetails.replace(/\s+/g, ' ');
    }

    if (!item.delivery_info) {
        const deliveryText = $('div:contains("Free Delivery"), span:contains("Free Delivery"), .delivery-returns').first().text().trim();
        if (deliveryText) item.delivery_info = deliveryText;
    }

    if (item && item.id) {
        productBuffer.push(item);
        saved++;
        // Less verbose log
        if (saved % 10 === 0) log.info(`Saved ${saved} products`);
        await pushBufferedData();
    } else {
        log.debug(`Could not extract valid product from ${request.url}`);
        await Actor.setValue(`DEBUG_FAIL_${Math.random()}`, html, { contentType: 'text/html' });
    }
}
