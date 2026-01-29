// ASOS REST API Client - Direct API calls for reliable data extraction
import { gotScraping } from 'got-scraping';
import { log } from 'apify';

/**
 * Fetch products from ASOS Search API
 * @param {string} keyword - Search keyword
 * @param {number} page - Page number (0-indexed for API)
 * @param {object} options - Additional options (store, currency, sort, etc.)
 * @returns {Promise<object>} - API response with products array
 */
export async function fetchSearchAPI(keyword, page = 0, options = {}) {
    const {
        store = 'US',
        currency = 'USD',
        lang = 'en-US',
        limit = 72,
        sortBy = 'pricedesc',
    } = options;

    const offset = page * limit;
    const url = new URL('https://www.asos.com/api/product/search/v2/categories');

    url.searchParams.set('q', keyword);
    url.searchParams.set('store', store);
    url.searchParams.set('lang', lang);
    url.searchParams.set('currency', currency);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('country', store);
    url.searchParams.set('keyStoreDataversion', 'ornjx7v-35'); // May need periodic update

    if (sortBy) {
        url.searchParams.set('sort', sortBy);
    }

    try {
        log.info(`Fetching ASOS Search API: ${keyword} (page ${page})`);

        const response = await gotScraping({
            url: url.toString(),
            method: 'GET',
            headers: buildApiHeaders(),
            responseType: 'json',
            timeout: { request: 30000 },
            retry: { limit: 2 },
        });

        const data = response.body;

        if (!data || !data.products) {
            log.warning('API response missing products array');
            return { products: [], itemCount: 0 };
        }

        log.info(`API returned ${data.products?.length || 0} products`);
        return {
            products: data.products || [],
            itemCount: data.itemCount || 0,
            facets: data.facets || [],
            pagination: {
                page: Math.floor(offset / limit),
                pageSize: limit,
                totalResults: data.itemCount || 0,
                totalPages: Math.ceil((data.itemCount || 0) / limit),
            },
        };
    } catch (error) {
        log.error(`ASOS Search API failed: ${error.message}`);
        return { products: [], itemCount: 0, error: error.message };
    }
}

/**
 * Fetch stock and price data for specific products
 * @param {string|string[]} productIds - Single ID or array of IDs
 * @param {object} options - Store and currency options
 * @returns {Promise<object[]>} - Array of stock/price data
 */
export async function fetchStockPriceAPI(productIds, options = {}) {
    const {
        store = 'US',
        currency = 'USD',
        country = 'US',
    } = options;

    const ids = Array.isArray(productIds) ? productIds.join(',') : String(productIds);

    const url = new URL('https://www.asos.com/api/product/catalogue/v4/stockprice');
    url.searchParams.set('productIds', ids);
    url.searchParams.set('store', store);
    url.searchParams.set('currency', currency);
    url.searchParams.set('keyStoreDataversion', 'ornjx7v-35');
    url.searchParams.set('country', country);

    try {
        log.debug(`Fetching stock/price for products: ${ids}`);

        const response = await gotScraping({
            url: url.toString(),
            method: 'GET',
            headers: buildApiHeaders(),
            responseType: 'json',
            timeout: { request: 20000 },
            retry: { limit: 1 },
        });

        return response.body || [];
    } catch (error) {
        log.debug(`Stock/Price API failed: ${error.message}`);
        return [];
    }
}

/**
 * Build realistic headers for API requests
 * @returns {object} - Headers object
 */
function buildApiHeaders() {
    return {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'asos-c-name': 'asos-web-product-listing-page',
        'asos-cid': 'web-product-listing-page',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'referer': 'https://www.asos.com/search/',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
}

/**
 * Normalize API product data to consistent format
 * @param {object} product - Raw API product object
 * @returns {object} - Normalized product
 */
export function normalizeApiProduct(product) {
    if (!product) return null;

    const id = String(product.id || product.productId || '');
    const price = product.price || {};
    const currentPrice = price.current?.value ?? price.value ?? null;
    const previousPrice = price.previous?.value ?? price.rrp?.value ?? price.was?.value ?? null;

    return {
        id,
        name: product.name || product.title || null,
        brandName: product.brandName || product.brand?.name || null,
        price: {
            current: {
                value: currentPrice,
                text: price.current?.text || (currentPrice ? `${price.currency || ''}${currentPrice}` : null),
            },
            previous: {
                value: previousPrice,
                text: previousPrice ? `${price.currency || ''}${previousPrice}` : null,
            },
            currency: price.currency || 'USD',
            isMarkedDown: price.isMarkedDown || (previousPrice && currentPrice && previousPrice > currentPrice) || false,
        },
        url: product.url?.startsWith('http') ? product.url : `https://www.asos.com${product.url || ''}`,
        imageUrl: product.imageUrl || product.images?.[0]?.url || null,
        colour: product.colour || product.colourWayId || product.color || null,
        isInStock: product.isInStock ?? !product.isNoSize ?? true,
        productCode: product.productCode || product.sku || null,
        badges: product.badges || [],
        productType: product.productType || null,
    };
}
