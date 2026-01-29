
// ASOS Product Scraper - Cheerio implementation
import { CheerioCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    keyword = 'men',
    startUrl,
    // filters
    minPrice,
    maxPrice,
    sortBy = 'pricedesc',
    results_wanted: RESULTS_WANTED_RAW = 20,
    proxyConfiguration: proxyConfig,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;

log.info(`Starting ASOS scraper for keyword: "${keyword}", results wanted: ${RESULTS_WANTED}`);

// Helper to build search URL
const buildSearchUrl = (kw, offset = 0) => {
    // Note: ASOS often redirects standard category URLs. 
    // We observe from research that fetching product data is best done via
    // the API-like structure or by hitting the PLP (Product Listing Page) and parsing window.asos.
    // However, finding the right PLP URL for a query is tricky without a search step.
    // For specific categories, we use the category ID.
    // Ideally, we start with a known URL.

    // If we have to construct one from keywords, it's harder.
    // We'll trust 'startUrl' mostly.

    // Fallback: search page
    return `https://www.asos.com/search/?q=${encodeURIComponent(kw)}&page=${Math.floor(offset / 72) + 1}`;
};

const normalizeImageUrl = (url) => {
    if (!url) return null;
    let cleanUrl = url.startsWith('//') ? `https:${url}` : url;
    if (!cleanUrl.startsWith('http')) cleanUrl = `https://images.asos-media.com/products/${url}`;
    return cleanUrl.split('?')[0];
};

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 5,
        sessionOptions: { maxUsageCount: 5 },
    },
    // ASOS is tough, limit concurrency
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 60,
    ignoreSslErrors: true,


    async requestHandler({ $, request, crawler: crawlerInstance, body }) {
        const offset = request.userData?.offset || 0;
        log.info(`Processing: ${request.url}`);

        // 1. Extract data from window.asos
        const html = $('body').html() || '';
        log.info(`Page title: ${$('title').text()}`);

        const scriptContent = $('script').map((i, el) => $(el).html()).get().find(s => s && s.includes('window.asos'));

        let products = [];

        if (scriptContent) {
            try {
                // Use Regex to capture the JSON object - handles whitespace variations
                const match = scriptContent.match(/window\.asos\s*=\s*(\{.+?\});/s);
                if (match && match[1]) {
                    const asosData = JSON.parse(match[1]);

                    // Navigate to products
                    const plpProducts = asosData.plp?.products ||
                        asosData.search?.products ||
                        asosData.plp?.results ||
                        [];

                    if (plpProducts.length > 0) {
                        products = plpProducts;
                        log.info(`Found ${products.length} products in window.asos`);
                    } else {
                        log.warning('window.asos found but no products in plp.products/search.products');
                        log.debug('ASOS Keys:', Object.keys(asosData));
                        if (asosData.plp) log.debug('PLP Keys:', Object.keys(asosData.plp));
                    }
                } else {
                    log.warning('Could not regex match window.asos JSON');
                }
            } catch (e) {
                log.warning(`Failed to parse window.asos: ${e.message}`);
            }
        } else {
            log.warning('"window.asos" script tag not found.');
        }

        // Fallback: If window.asos failed or was empty, check __NEXT_DATA__
        if (products.length === 0) {
            const nextDataScript = $('#__NEXT_DATA__').html();
            if (nextDataScript) {
                try {
                    const nextData = JSON.parse(nextDataScript);
                    const p1 = nextData.props?.pageProps?.searchResults?.products;
                    const p2 = nextData.props?.pageProps?.products;
                    if (p1) products = p1;
                    else if (p2) products = p2;
                } catch (e) {
                    log.warning(`Failed to parse __NEXT_DATA__: ${e.message}`);
                }
            }
        }

        // Process products
        const normalizedProducts = [];
        for (const p of products) {
            if (!p || !p.id) continue;

            // Map ASOS data to schema
            const product = {
                product_id: String(p.id),
                title: p.name,
                price: p.price?.current?.text || p.price?.current?.value,
                currency: p.price?.currency?.text,
                brand: p.brandName,
                url: p.url ? `https://www.asos.com${p.url}` : `https://www.asos.com/prd/${p.id}`,
                image_url: normalizeImageUrl(p.imageUrl || p.images?.[0]?.url),
                is_in_stock: p.isNoSize ? false : (p.isInStock !== false),
                discount: p.price?.isMarkedDown ? 'Yes' : 'No',
            };
            normalizedProducts.push(product);
        }

        // Save
        for (const p of normalizedProducts) {
            if (saved >= RESULTS_WANTED) break;
            if (!seenIds.has(p.product_id)) {
                seenIds.add(p.product_id);
                await Dataset.pushData(p);
                saved++;
            }
        }

        log.info(`Saved ${saved}/${RESULTS_WANTED} products so far.`);

        // Pagination
        // We calculate next page based on offset or just increment page number if using page param
        if (saved < RESULTS_WANTED && products.length > 0) {
            // ASOS standard page size is 72, or we can check header info
            if (request.url.includes('page=')) {
                const currentUrl = new URL(request.url);
                const currentPage = parseInt(currentUrl.searchParams.get('page') || '1');
                const nextPage = currentPage + 1;
                currentUrl.searchParams.set('page', String(nextPage));

                log.info(`Enqueueing next page: ${nextPage}`);
                await crawlerInstance.addRequests([{
                    url: currentUrl.href,
                    userData: { offset: offset + products.length }
                }]);
            } else {
                // If existing URL didn't have page, add page=2
                const currentUrl = new URL(request.url);
                currentUrl.searchParams.set('page', '2');
                log.info(`Enqueueing page 2`);
                await crawlerInstance.addRequests([{
                    url: currentUrl.href,
                    userData: { offset: offset + products.length }
                }]);
            }
        }
    },


});

// Determine start URLs
const urls = [];
if (startUrl) {
    urls.push(startUrl);
} else {
    // Default fallback
    urls.push(buildSearchUrl(keyword, 0));
}

await crawler.run(urls);

await Actor.exit();
