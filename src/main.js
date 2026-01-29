// ASOS Product Scraper - Production-Ready Listing-Only Extractor
// Optimized for speed and stealth - extracts complete data from listing pages only
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { HeaderGenerator } from 'header-generator';
import { gotScraping } from 'got-scraping';
import vm from 'node:vm';

await Actor.init();

// ========================================
// API CLIENT FUNCTIONS (Merged from api-client.js)
// ========================================

/**
 * Fetch products from ASOS Search API
 * @param {string} keyword - Search keyword
 * @param {number} page - Page number (0-indexed for API)
 * @param {object} options - Additional options (store, currency, sort, etc.)
 * @returns {Promise<object>} - API response with products array
 */
async function fetchSearchAPI(keyword, page = 0, options = {}) {
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
    url.searchParams.set('keyStoreDataversion', 'ornjx7v-35');

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

        log.info(`✓ API returned ${data.products?.length || 0} products`);
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
        log.debug(`ASOS Search API failed: ${error.message}`);
        return { products: [], itemCount: 0, error: error.message };
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
function normalizeApiProduct(product) {
    if (!product) return null;

    const id = String(product.id || product.productId || '');
    const price = product.price || {};
    const currentPrice = price.current?.value ?? price.value ?? null;
    const previousPrice = price.previous?.value ?? price.rrp?.value ?? price.was?.value ?? null;

    return {
        id,
        name: product.name || product.title || null,
        brandName: product.brandName || product.brand?.name || product.brand || null,
        price: {
            current: {
                value: currentPrice,
                text: price.current?.text || (currentPrice ? `${price.currency || ''}${currentPrice}` : null),
            },
            previous: {
                value: previousPrice,
                text: previousPrice ? `${price.currency || ''}${previousPrice}` : null,
            },
            was: {
                value: price.was?.value ?? null,
            },
            rrp: {
                value: price.rrp?.value ?? null,
            },
            currency: price.currency || 'USD',
            isMarkedDown: price.isMarkedDown || (previousPrice && currentPrice && previousPrice > currentPrice) || false,
        },
        url: product.url?.startsWith('http') ? product.url : `https://www.asos.com${product.url || ''}`,
        imageUrl: product.imageUrl || product.images?.[0]?.url || product.media?.images?.[0]?.url || null,
        images: product.images || [],
        colour: product.colour || product.colourWayId || product.color || product.colourWayLabel || null,
        isInStock: product.isInStock ?? !product.isNoSize ?? true,
        isMarkedDown: price.isMarkedDown || (previousPrice && currentPrice && previousPrice > currentPrice) || false,
        productCode: product.productCode || product.sku || null,
        badges: product.badges || [],
        productType: product.productType || null,
    };
}

// ========================================
// MAIN SCRAPER LOGIC
// ========================================

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
let shouldStop = false; // Global flag to stop crawling

// Track extraction methods for monitoring
const extractionStats = {
    windowAsos: 0,
    restApi: 0,
    nextData: 0,
    domParsing: 0,
};

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
    maxConcurrency: 5, // Increased from 3 for better speed
    requestHandlerTimeoutSecs: 60,
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 20, sessionOptions: { maxUsageCount: 15 } },
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
        async ({ request }) => {
            const headers = headerGenerator.getHeaders();
            request.headers = { ...headers, ...request.headers };
            
            // Add random delay for stealth (200-800ms)
            await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 600));
        },
    ],
    async requestHandler({ $, request, body, crawler: crawlerInstance }) {
        // Check if we should stop processing
        if (shouldStop || saved >= resultsWanted) {
            log.info(`Already reached target of ${resultsWanted} products. Skipping request.`);
            return;
        }

        const html = body?.toString?.() || '';
        log.info(`Processing listing: ${request.url}`);

        const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
        log.info(`Page title: ${title}`);

        let products = [];
        let extractionMethod = null;
        let pagination = null;

        // WATERFALL EXTRACTION: window.asos -> REST API -> __NEXT_DATA__ -> DOM

        // 1. Try window.asos (most reliable for SSR pages)
        const windowAsos = extractWindowAsos(html);
        products = getProductsFromWindow(windowAsos);
        if (products.length) {
            extractionMethod = 'window.asos';
            extractionStats.windowAsos++;
            pagination = extractPagination(windowAsos);
            log.info(`✓ Extracted ${products.length} products via window.asos`);
        }

        // 2. Try REST API (more stable than DOM, faster than full page render)
        if (!products.length) {
            try {
                const urlObj = new URL(request.url);
                const apiKeyword = urlObj.searchParams.get('q') || keyword;
                const apiPage = Number(urlObj.searchParams.get('page') || 1) - 1; // API is 0-indexed

                const apiResponse = await fetchSearchAPI(apiKeyword, apiPage, { sortBy });
                if (apiResponse.products?.length) {
                    products = apiResponse.products.map(normalizeApiProduct).filter(Boolean);
                    pagination = apiResponse.pagination;
                    extractionMethod = 'REST API';
                    extractionStats.restApi++;
                    log.info(`✓ Extracted ${products.length} products via REST API`);
                }
            } catch (apiError) {
                log.debug(`REST API extraction failed: ${apiError.message}`);
            }
        }

        // 3. Try __NEXT_DATA__ (Next.js fallback)
        if (!products.length) {
            const nextData = extractNextData(html);
            products = getProductsFromWindow(nextData);
            if (products.length) {
                extractionMethod = '__NEXT_DATA__';
                extractionStats.nextData++;
                pagination = extractPagination(nextData);
                log.info(`✓ Extracted ${products.length} products via __NEXT_DATA__`);
            }
        }

        // 4. Fallback: DOM Parsing (last resort)
        if (!products.length) {
            products = parseDomProducts(html, $);
            if (products.length) {
                extractionMethod = 'DOM parsing';
                extractionStats.domParsing++;
                pagination = extractPaginationFromUrl(request.url);
                log.info(`✓ Recovered ${products.length} products via DOM parsing`);
            }
        }

        if (!products.length) {
            log.warning(`✗ No products found on ${request.url} after all extraction methods`);
            await Actor.setValue('DEBUG_HTML_LISTING', html, { contentType: 'text/html' });
            return;
        }

        // ==================================================
        // SAVE PRODUCTS DIRECTLY FROM LISTING (No detail page visits!)
        // ==================================================
        
        const filtered = products.filter((p) => pricePasses(p.price, minPrice, maxPrice));
        const needed = resultsWanted - saved;
        const toSave = filtered.slice(0, needed);

        log.info(`Found ${filtered.length} products, saving ${toSave.length} directly (already have ${saved}/${resultsWanted})`);

        for (const p of toSave) {
            if (saved >= resultsWanted) {
                shouldStop = true;
                break;
            }

            const id = String(p.id || p.productId || '');
            if (id && seenIds.has(id)) {
                log.debug(`Skipping duplicate product ID: ${id}`);
                continue;
            }
            if (id) seenIds.add(id);

            // Transform to final output format
            const finalProduct = transformToFinalFormat(p);
            
            // Validate critical fields before saving
            if (!finalProduct.product_id || !finalProduct.title || !finalProduct.product_url) {
                log.warning(`Skipping product with missing critical data: ${finalProduct.product_id || 'unknown'}`);
                continue;
            }

            productBuffer.push(finalProduct);
            saved++;

            if (saved % 10 === 0) log.info(`Saved ${saved} products`);
            await pushBufferedData();
            
            if (saved >= resultsWanted) {
                shouldStop = true;
                log.info(`✓ Reached target of ${resultsWanted} products!`);
                break;
            }
        }

        // Listing Pagination - only if we still need more products
        if (saved < resultsWanted && toSave.length === filtered.length) {
            const pagination = extractPagination(windowAsos) || extractPaginationFromUrl(request.url);
            const nextUrl = nextPageUrl(request.url, pagination, products.length);
            if (nextUrl) {
                log.info(`Enqueueing next page: ${nextUrl}`);
                await crawlerInstance.addRequests([{ url: nextUrl }]);
            } else {
                log.info(`No more pages available`);
            }
        } else {
            log.info(`Not enqueueing next page - have enough products or reached limit`);
        }
    },
});

// ========================================
// EXECUTION
// ========================================

await crawler.run([startUrl || buildSearchUrl(1)]);

log.info('Crawl finished.');

// Log extraction method statistics for monitoring
log.info('Extraction method usage:', extractionStats);

await pushBufferedData(true);
await Actor.exit();

// ========================================
// PRODUCT TRANSFORMATION & FORMATTING
// ========================================

/**
 * Transform listing product to final output format
 * @param {object} p - Product from listing extraction
 * @returns {object} - Final formatted product
 */
function transformToFinalFormat(p) {
    const id = String(p.id || p.productId || '');
    const currentPrice = extractPriceValue(p.price);
    const originalPrice = p.price?.previous?.value ?? p.price?.was?.value ?? p.price?.rrp?.value ?? null;
    const currency = p.price?.currency || p.currency || '£';
    
    // Calculate discount
    let discount = null;
    if (originalPrice && currentPrice && originalPrice > currentPrice) {
        discount = `${Math.round(((originalPrice - currentPrice) / originalPrice) * 100)}%`;
    }
    
    // Format prices
    const formattedPrice = currentPrice ? `${currency}${currentPrice.toFixed(2)}` : null;
    const formattedOriginalPrice = originalPrice ? `${currency}${originalPrice.toFixed(2)}` : null;
    
    // Determine URL
    let productUrl = p.url || p.productUrl;
    if (productUrl && !productUrl.startsWith('http')) {
        productUrl = `https://www.asos.com${productUrl}`;
    }
    
    // Get brand - try all possible properties
    const brand = p.brandName || p.brand?.name || p.brand || null;
    
    // Get color - try all variants
    const color = p.colour || p.color || p.colourWayLabel || p.colourWayId || null;
    
    // Get description from available sources
    // Some products have description in productType, badges, or additionalImageUrls text
    let description = null;
    if (p.productType && p.productType !== 'Product') {
        description = p.productType;
    } else if (p.badges && p.badges.length > 0) {
        const badgeTexts = p.badges.map(b => b.text || b.label).filter(Boolean);
        if (badgeTexts.length > 0) {
            // Clean up badge text - separate "MORE COLOURS" and "Selling fast"
            description = badgeTexts.join(' | ')
                .replace(/MORE\s*COLOURS/gi, 'More Colors')
                .replace(/Selling\s*fast/gi, 'Selling Fast')
                .replace(/\s+/g, ' ')
                .trim();
        }
    }
    
    // If description is just badges concatenated, clean it up
    if (description) {
        description = description
            .replace(/([a-z])([A-Z])/g, '$1 | $2') // Add separator between camelCase
            .replace(/\s+\|\s+/g, ' | ') // Normalize separators
            .trim();
    }
    
    // Get best available image
    const imageUrl = p.imageUrl || p.images?.[0]?.url || p.media?.images?.[0]?.url || null;
    
    return {
        product_id: id,
        title: p.name || p.title || null,
        brand: brand,
        price: formattedPrice,
        original_price: formattedOriginalPrice,
        discount: discount,
        currency: currency,
        color: color,
        size_available: 'Available online', // Listing pages don't have detailed size info
        is_sale: p.isMarkedDown || p.price?.isMarkedDown || (originalPrice && currentPrice && originalPrice > currentPrice) ? 'Yes' : 'No',
        product_url: productUrl,
        image_url: normalizeImageUrl(imageUrl),
        description: description,
    };
}

// ========================================
// EXTRACTION UTILITY FUNCTIONS
// ========================================

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
    
    // Handle protocol-relative URLs
    if (clean.startsWith('//')) clean = `https:${clean}`;
    
    // Handle relative paths
    if (!clean.startsWith('http')) {
        clean = `https://images.asos-media.com/products/${clean}`;
    }
    
    // Remove query parameters first
    clean = clean.split('?')[0];
    
    // ASOS images need proper size suffix and extension
    // If URL doesn't have an extension or size suffix, add them
    if (!clean.match(/\.(jpg|jpeg|png|webp)$/i)) {
        // Check if it already has a size suffix (e.g., -1-black, -2-white)
        if (!clean.match(/-\d+-[a-z]+$/i)) {
            // Add default size suffix if missing
            clean = `${clean}-1-product`;
        }
        // Add .jpg extension
        clean = `${clean}.jpg`;
    }
    
    // Ensure high-quality image by specifying dimensions
    // ASOS supports ?$XXL$ format for better quality
    if (!clean.includes('?')) {
        clean = `${clean}?$XXL$`;
    }
    
    return clean;
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

            // Image - ASOS uses lazy loading, check multiple attributes
            const img = tile.find('img[class*="productImage"], img').first();
            let imageUrl = null;
            
            // Priority order: data-src (lazy load), src, srcset
            imageUrl = img.attr('data-src') || img.attr('src');
            
            // If still no image, try srcset
            if (!imageUrl || imageUrl.includes('placeholder') || imageUrl.includes('data:image')) {
                const srcset = img.attr('srcset') || img.attr('data-srcset');
                if (srcset) {
                    // Get first or highest quality image from srcset
                    const srcsetImages = srcset.split(',').map(s => s.trim().split(' ')[0]);
                    imageUrl = srcsetImages[0] || null;
                }
            }
            
            // Normalize and ensure proper format
            if (imageUrl && !imageUrl.includes('placeholder') && !imageUrl.includes('data:image')) {
                imageUrl = normalizeImageUrl(imageUrl);
            } else {
                imageUrl = null;
            }

            // Title & Brand
            // Description often contains both Brand + Title or just Title
            const descriptionText = tile.find('p[class*="productDescription"]').text().trim();
            const ariaLabel = infoDivAttr(tile, link, 'aria-label');

            // Try to extract brand from title
            // ASOS titles follow: "Brand Name product description"
            // Brand is capitalized, product description starts with lowercase
            let brandName = null;
            if (descriptionText) {
                // Match only capitalized words, stop at first lowercase word
                // This handles: "New Balance", "Polo Ralph Lauren", "ASOS DESIGN"
                // But stops at: "Dune London Insight" -> "Dune London"
                const brandMatch = descriptionText.match(/^([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*?)\s+[a-z]/);
                if (brandMatch) {
                    brandName = brandMatch[1].trim();
                } else {
                    // Fallback: if entire title is capitalized (like "ASOS DESIGN")
                    const fallbackMatch = descriptionText.match(/^([A-Z][A-Z\s&]+)/);
                    if (fallbackMatch) {
                        brandName = fallbackMatch[1].trim().split(/\s{2,}/)[0]; // Stop at double space
                    }
                }
            }

            // Prices - extract both current and previous (was) prices
            const priceSection = tile.find('span[class*="price"]').first().parent();
            const currentPriceText = tile.find('span[data-testid="current-price"]').text() ||
                tile.find('span[class*="currentPrice"]').text() ||
                tile.find('span[class*="saleAmount"]').text() ||
                tile.find('span[class*="price"]').first().text();

            // Try to find previous/was price
            const previousPriceText = tile.find('span[data-testid="previous-price"]').text() ||
                tile.find('span[class*="previousPrice"]').text() ||
                tile.find('span[class*="wasPrice"]').text() ||
                priceSection.find('span:contains("Was")').text().replace(/Was\s*/i, '') ||
                null;

            const priceVal = parsePriceText(currentPriceText);
            const previousPriceVal = parsePriceText(previousPriceText);

            // Aria-label is usually "Title, current price $XX, original price $YY"
            let title = descriptionText;
            if (!title && ariaLabel) {
                title = ariaLabel.split(/current price|Original price/i)[0].replace(/,$/, '').trim();
            }

            // Clean title if it contains price
            if (title && priceVal) {
                title = title.replace(/\s*[£$€]\d+\.\d+.*$/, '').trim();
            }

            // Currency
            let currency = null;
            if (currentPriceText) {
                const currencyMatch = currentPriceText.match(/[$£€]/);
                if (currencyMatch) currency = currencyMatch[0];
            }

            // Try to extract color from title or aria-label
            // Colors appear as "in [color]" but stop before extra descriptors
            let color = null;
            
            // First try from title/description
            if (title || descriptionText) {
                const text = title || descriptionText;
                // Match "in [color]" but stop at common separators
                const colorMatch = text.match(/\s+in\s+([a-z][a-z\s/-]+?)(?:\s+(?:with|Exclusive|nubuck|leather|suede|fabric|-|$)|$)/i);
                if (colorMatch) {
                    color = colorMatch[1].trim();
                    // Clean up: remove trailing material words
                    color = color.replace(/\s+(leather|suede|nubuck|fabric|material|print|croc)$/i, '').trim();
                }
            }
            
            // Fallback: try aria-label
            if (!color && ariaLabel) {
                const colorMatch = ariaLabel.match(/\s+in\s+([a-z][a-z\s/-]+?)(?:,|\s+current|\s+with|$)/i);
                if (colorMatch) {
                    color = colorMatch[1].trim();
                    color = color.replace(/\s+(leather|suede|nubuck|fabric|material)$/i, '').trim();
                }
            }

            // Badge / Product Type - extract and clean up
            const badgeElements = tile.find('div[class*="sellingFast"], span[class*="overlay"], div[class*="badge"], span[class*="badge"]');
            let badges = [];
            
            badgeElements.each((idx, el) => {
                const badgeText = $(el).text().trim();
                if (badgeText && badgeText.length > 0) {
                    badges.push(badgeText);
                }
            });
            
            // Clean and deduplicate badges
            badges = [...new Set(badges)];
            const badge = badges.length > 0 ? badges.join(' | ') : null;

            products.push({
                id,
                name: title,
                url: href,
                imageUrl,
                price: {
                    current: { value: priceVal, text: currentPriceText },
                    previous: { value: previousPriceVal, text: previousPriceText },
                    was: { value: previousPriceVal },
                    rrp: { value: previousPriceVal },
                    isMarkedDown: previousPriceVal && priceVal && previousPriceVal > priceVal,
                },
                brandName: brandName,
                colour: color,
                isMarkedDown: previousPriceVal && priceVal && previousPriceVal > priceVal,
                currency: currency,
                badge: badge,
                productType: badge,
                badges: badge ? [{ text: badge }] : [],
            });
        } catch (e) {
            // Ignore (log.debug(e.message) if needed)
        }
    });

    return products;
}

