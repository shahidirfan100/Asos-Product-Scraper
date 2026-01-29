# ASOS Product Scraper

Scrape ASOS product listings at scale. Extract prices, brands, colors, sizes, discounts, and product images from one of the world's leading fashion retailers. Perfect for fashion market research, price monitoring, competitor analysis, and trend tracking.

## Features

- **Keyword Search** — Search products using any keyword or phrase
- **Direct URL Support** — Start from any ASOS category or search results page
- **Category Filtering** — Filter by specific ASOS category IDs
- **Price Filtering** — Filter by minimum and maximum price range
- **Sorting Options** — Sort by price (high to low, low to high) or newest items
- **Size & Color Filters** — Filter products by size and color preferences
- **Brand Filtering** — Search within specific brands
- **Sale Detection** — Identify products on sale and outlet items
- **Stock Status** — Check product availability
- **High Volume** — Collect hundreds or thousands of products per run

## Use Cases

### Fashion Market Research
Discover trending fashion items and analyze pricing strategies across categories. Identify best-selling styles and understand seasonal demand patterns.

### Price Monitoring
Track competitor pricing in real-time. Monitor price fluctuations, sale patterns, and discount strategies to optimize your own pricing.

### Competitive Analysis
Benchmark your products against competitors. Analyze pricing, brand positioning, and product assortments across the fashion marketplace.

### Trend Analysis
Identify emerging fashion trends by analyzing product launches, popular colors, and trending styles across different categories.

### Inventory Planning
Track product availability and stock levels across categories. Monitor what sells out quickly to inform your inventory decisions.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keyword` | String | No | `"men"` | Search term to find products |
| `startUrl` | String | No | — | Direct ASOS search or category URL |
| `categoryId` | String | No | — | ASOS category ID to filter results |
| `minPrice` | Number | No | — | Minimum product price |
| `maxPrice` | Number | No | — | Maximum product price |
| `sortBy` | String | No | `"pricedesc"` | Sort order: `pricedesc`, `priceasc`, `freshness` |
| `sizeFilter` | String | No | — | Filter by size (e.g., 'S', 'M', 'L', 'XL') |
| `colorFilter` | String | No | — | Filter by color ID |
| `brandFilter` | String | No | — | Filter by brand ID |
| `results_wanted` | Integer | No | `20` | Maximum number of products to collect |
| `proxyConfiguration` | Object | No | Residential | Proxy settings for requests |

---

## Output Data

Each product in the dataset contains the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `product_id` | String | Unique ASOS product identifier |
| `title` | String | Full product title and description |
| `brand` | String | Product brand name |
| `price` | String | Current sale price with currency symbol |
| `original_price` | String | Original price before discount (if applicable) |
| `discount` | String | Discount information (e.g., "20% off" or "Outlet") |
| `currency` | String | Currency code (USD, GBP, EUR, etc.) |
| `color` | String | Product color |
| `size_available` | Boolean | Whether product is in stock |
| `image_url` | String | Main product image URL |
| `product_url` | String | Direct link to product detail page |
| `is_outlet` | Boolean | Whether product is from outlet section |
| `is_sale` | Boolean | Whether product is on sale |

---

## Usage Examples

### Basic Keyword Search

Search for products using a simple keyword:

```json
{
    "keyword": "dresses",
    "results_wanted": 50
}
```

### Price Range Filter

Find products within a specific price range:

```json
{
    "keyword": "sneakers",
    "minPrice": 50,
    "maxPrice": 150,
    "results_wanted": 100
}
```

### Sort by Price

Get products sorted by price:

```json
{
    "keyword": "jackets",
    "sortBy": "priceasc",
    "results_wanted": 200
}
```

### Direct URL Input

Start from a specific category page:

```json
{
    "startUrl": "https://www.asos.com/men/ctas/curated-category-3/cat/?cid=51451",
    "results_wanted": 150
}
```

### Filter by Size

Search for products in a specific size:

```json
{
    "keyword": "shirts",
    "sizeFilter": "M",
    "results_wanted": 50
}
```

---

## Sample Output

```json
{
    "product_id": "204258116",
    "title": "ASOS DESIGN slim fit shirt in navy",
    "brand": "ASOS DESIGN",
    "price": "$29.00",
    "original_price": "$45.00",
    "discount": "35% off",
    "currency": "USD",
    "color": "Navy",
    "size_available": true,
    "image_url": "https://images.asos-media.com/products/204258116/204258116-1-product.jpg",
    "product_url": "https://www.asos.com/prd/204258116",
    "is_outlet": false,
    "is_sale": true
}
```

---

## Tips for Best Results

### Optimize Your Search Keywords
- Use specific, descriptive keywords for more relevant results
- Include product type, gender, or style (e.g., "men shoes", "women dresses")
- Try variations of your search term to capture more products

### Use Price Filters Effectively
- Set realistic price ranges based on your target market
- Combine price filters with sorting for better results
- Use `priceasc` sorting to find budget-friendly options

### Maximize Data Quality
- Start with smaller batches (20-50) for testing
- Use `freshness` sorting to find newest arrivals
- Filter by category or brand when available for focused results

### Filter by Size and Color
- Use size filters to focus on specific size ranges
- Combine color and size filters for precise targeting
- Check stock availability with the `size_available` field

### Proxy Configuration
For optimal performance, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Integrations

Connect your scraped data with popular tools and platforms:

- **Google Sheets** — Automatically sync products to spreadsheets
- **Airtable** — Build product databases and fashion catalogs
- **Zapier** — Trigger workflows based on new products
- **Make (Integromat)** — Create automated data pipelines
- **Webhooks** — Send data to your custom endpoints
- **Slack** — Get notifications for new products
- **Email** — Receive automated reports

### Export Formats

Download your data in multiple formats:

- **JSON** — For developers and API integrations
- **CSV** — For spreadsheet analysis and Excel
- **Excel** — For business reporting and presentations
- **XML** — For legacy system integrations

---

## Important Data Notes

> [!NOTE]
> **ASOS Product Data**: The scraper extracts data from ASOS's product catalog, which includes both regular items and sale/outlet products. All data is fetched in real-time from ASOS's search results.

**What data is always available:**
- Product ID, title, brand, price, currency
- Product image and URL
- Color information
- Stock availability status

**What data is conditional:**
- Original price (only for sale items)
- Discount percentage (only for sale items)
- Outlet flag (only for outlet products)
- Sale status (depends on current promotions)

**Data accuracy notes:**
- Prices reflect current ASOS pricing at time of scrape
- Stock availability may change rapidly for popular items
- Sale/discount information is time-sensitive

---

## Frequently Asked Questions

### How many products can I scrape?
You can collect thousands of products per run. The practical limit depends on your search query and ASOS search results availability (typically hundreds of products per category).

### How often is the data updated?
Each run fetches real-time data directly from ASOS. Schedule regular runs to keep your data fresh and track price changes.

### Can I search specific categories?
Yes, use the `categoryId` parameter with a category ID, or provide a direct category URL in the `startUrl` field.

### What if some fields are empty?
Product listings vary in completeness. Some products may not have sale prices or may be out of stock. The scraper extracts all available data for each product.

### How do I get more products?
Use broader keyword terms, remove filters, or set a higher `results_wanted` value. You can also run multiple searches with different parameters.

### Can I filter by multiple sizes?
Currently, the scraper supports single size filter per run. To get multiple sizes, run separate searches for each size requirement.

### Does this scrape product details pages?
This scraper focuses on search/catalog results. For detailed product information (full descriptions, all images, sizing charts), consider using a dedicated product detail scraper.

---

## Support & Resources

- **[Apify Documentation](https://docs.apify.com/)** — Platform guides and tutorials
- **[Apify Console](https://console.apify.com/)** — Manage runs and view results
- **[API Reference](https://docs.apify.com/api/v2)** — Programmatic access documentation

For issues or feature requests, contact support through the Apify Console.

---

## Legal & Compliance

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring their use complies with ASOS terms of service and applicable laws. Always respect rate limits and use data responsibly. This scraper is intended for public product catalog information only.
