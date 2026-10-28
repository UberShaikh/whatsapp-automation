# Indian household grocery seed data

Prepared on 28 October 2026. The [JSON dataset](indian-household-groceries.json) contains 33 researched product variants for development/staging. The explicit manual importer is now implemented; there is no startup hook. Its target is the isolated `grocery_dev` PostgreSQL schema, leaving platform-managed tables untouched.

Seeded on 28 October 2026: 33 products/variants, 33 current prices, 33 opening-stock movements and 792 total demo sellable packs in `DEMO-STORE`. Database verification matched every SKU's pack size, price, stock and image URL to the reviewed file. After conversion to TypeScript, all nine validation/database tests passed, including fresh inserts, pack-identity protection, transaction rollback and preserving stock across reimports. Migration and seed commands recognize the existing Python-created records without recreating them. These remain development prices and quantities, not approved production inventory.

## Manual import only

Review the file, then use the explicit preview and apply commands below. The importer upserts by stable SKU and applies opening stock once per SKU/location through an audited movement. Repeating an identical file is a no-op. Changed-file imports preserve existing stock, reject changes to a SKU's physical pack, and keep effective-dated price history. Later stock corrections are separate manual adjustments.

From the repository root in PowerShell, with `DATABASE_URL` configured privately in `.env` and `APP_ENV=development` (the default):

```powershell
npm ci
npm run seed:preview
npm run db:migrate
npm run seed -- --apply --expected-sha256 <hash-from-preview>
```

`--preview` is read-only and reports whether the schema is missing. `--init-schema` runs the explicit versioned SQL migration without importing products; reruns check the recorded migration checksum. `--apply` validates every row before writes, requires the exact reviewed file hash, serializes seed runs and commits the import as one transaction. A failed operation rolls back. No `.env` values are printed. This demo-only command rejects production `APP_ENV` values; never point it at a production database.

The importer is TypeScript and requires Node.js 24.12+; no Python environment is needed. Run `npm test` for local checks and `npm run typecheck` for strict type checking. To run the database checks explicitly, set `$env:SEED_INTEGRATION_TEST='1'` and run `npm test`; these checks require the seeded `grocery_dev` schema and roll back their simulated stock/price changes. They do not operate on platform tables. Express is the selected framework for the forthcoming HTTP service; seeding is a separate manual command with no server dependency.

Never import this file during application/worker startup, deployment or schema migrations. The importer rejects production environment settings. Replace demo data with reviewed store products, prices, stock and tax settings before designing a live import. The user's sheet can replace the starter data after explicit SKU mapping; never merge by product name alone.

## WhatsApp must not redirect to the sources

- `source_url` and `image_source_url` are internal provenance only. Never put them in customer messages, product buttons, menus or checkout redirects.
- `image_url` is an external media source for displaying the product picture, not a customer navigation destination.
- Show the store's product name, exact variant, price and stock-dependent choices in the conversation. Cart and order confirmation stay in this store's workflow.
- If an image is unavailable, send text-only product details. Do not fall back to a retailer/product-page link.
- A future hosted payment link is a separate checkout decision; retailer source links have no role in it.

## Field definitions and data quality

Each record has a stable local SKU, brand/category, exact pack size/count, INR demo price, demo opening stock, manually authored search aliases, source product identity, image URL and verification notes.

- `pack_quantity`/`pack_unit` describe one inner pack; `pack_count` is the number of inner packs sold together. Prices and stock are per complete sellable pack. Vim is 4 x 190 g (760 g total), not one 190 g bar.
- `demo_selling_price` is a decimal string for sample checkout. It is not an approved store price.
- `source_price_inr` and `source_mrp_inr` record values exposed in the opened listing when available. Content may be cached and location-dependent; null means unavailable, never free. The moong-dal listing's anomalous INR 1.00 price is preserved as `rejected_anomaly`; its demo price is INR 89.00 instead.
- All `demo_opening_stock_packs` values are invented test inventory at `DEMO-STORE`, including zero-stock and final-unit scenarios. They do not represent retailer or store inventory.
- Retailer product IDs are not barcodes/EANs. Tax rates, HSN codes, expiry dates and supplier details have not been inferred.
- Page content takes priority over stale URL names: Nescafe is 45 g, Fortune oil is 870 g, and Vim is 4 x 190 g. See each record's original source name and notes.
- Produce uses fixed 1 kg demo packs. Retailer `fresho!` branding is retained for attribution, not as a claim about the future store's supplier. Arbitrary loose-weight selling remains a business decision.
- Aliases such as atta, chawal, namak and doodh are manually written search hints. They never bypass brand/variant clarification.

## Images and research limits

All 33 image URLs were extracted from real product pages, not guessed from a filename convention. No image bytes were saved or uploaded. Thirty URLs opened through the research tool. Three could not be fetched: Everest Tikhalal, Nescafe Classic and the new potato. These carry `source_link_only_fetch_failed`; use text-only product summaries until verified.

`opened_by_research_tool` means tool accessibility, not future availability or visual pack-label inspection. Images are retailer thumbnails and may be small. Before enabling WhatsApp media, test content type, dimensions, size and accessibility from the deployed service/Meta. Do not guess alternative high-resolution paths.

Public image accessibility does not establish a commercial reuse license or reliable hotlinking. Permission has not been established. Review image usage before production. Failures must not block ordering or introduce retailer redirects.

Sources are the retailer's own listings below. Product names, packs and price references were checked through internet research on 28 October 2026 without a selected delivery pincode. Marketing descriptions, reviews and nutrition claims were not copied.

## Internal catalog review

The source links in this developer document are for review only and must not appear in WhatsApp.

| Product | Sellable pack | Demo price (INR) | Demo stock (packs) | Internal source |
| --- | --- | ---: | ---: | --- |
| India Gate Classic Basmati Rice | 1 kg | 251.00 | 24 | [Source](https://www.bigbasket.com/pd/243336/india-gate-basmati-rice-classic-1-kg-pouch/) |
| Tata Sampann Unpolished Chana Dal | 1 kg | 137.00 | 30 | [Source](https://www.bigbasket.com/pd/40000290/tata-sampann-unpolished-chana-dal-1-kg-pouch/) |
| Tata Sampann Unpolished Kabuli Chana - Medium Size | 500 g | 79.00 | 18 | [Source](https://www.bigbasket.com/pd/40296060/tata-sampann-kabuli-chana-unpolished-medium-size-500-g/) |
| Tata Sampann Turmeric Powder | 100 g | 44.00 | 36 | [Source](https://www.bigbasket.com/pd/40070758/tata-sampann-turmeric-powder-100-g/) |
| Everest Tikhalal Chilli Powder | 100 g | 54.00 | 25 | [Source](https://www.bigbasket.com/pd/242311/everest-powder-tikhalal-hot-chilly-100-g-pouch/) |
| Everest Coriander Powder | 100 g | 35.00 | 0 | [Source](https://www.bigbasket.com/pd/225304/everest-powder-coriander-100-g-pouch/) |
| Everest Garam Masala | 100 g | 88.00 | 20 | [Source](https://www.bigbasket.com/pd/268943/everest-garam-masala-100-g-carton/) |
| Amul Ghee | 500 ml | 322.00 | 12 | [Source](https://www.bigbasket.com/pd/40050541/amul-amul-ghee-500-ml-500-ml-pouch/) |
| Tata Tea Premium Leaf Tea | 250 g | 110.00 | 30 | [Source](https://www.bigbasket.com/pd/264445/tata-tea-premium-tea-250-g/) |
| Nescafe Classic Instant Coffee | 45 g | 230.00 | 15 | [Source](https://www.bigbasket.com/pd/267400/nescafe-classic-100-pure-instant-coffee-50-g-pouch/) |
| Parle Original Gluco Biscuits | 250 g | 25.00 | 48 | [Source](https://www.bigbasket.com/pd/20004286/parle-glucos-biscuits-parle-g-250-g/) |
| Britannia Marie Gold Biscuits | 250 g | 37.00 | 30 | [Source](https://www.bigbasket.com/pd/220244/britannia-marie-gold-biscuits-250-g/) |
| Maggi 2-Minute Instant Masala Noodles | 70 g | 15.00 | 60 | [Source](https://www.bigbasket.com/pd/266160/maggi-masala-instant-noodles-vegetarian-70-g-pouch/) |
| Kissan Fresh Tomato Ketchup | 500 g | 110.00 | 18 | [Source](https://www.bigbasket.com/pd/266541/kissan-fresh-tomato-ketchup-500-g-bottle/) |
| Amul Unsalted Butter | 100 g | 48.00 | 16 | [Source](https://www.bigbasket.com/pd/40069116/amul-unsalted-butter-100-g-carton/) |
| Amul Fresh Malai Paneer | 200 g | 76.00 | 10 | [Source](https://www.bigbasket.com/pd/40096747/amul-malai-fresh-paneer-200-g/) |
| Vim Lemon Dishwash Bar | 4 x 190 g | 85.00 | 24 | [Source](https://www.bigbasket.com/pd/266969/vim-dishwash-bar-lemon-200-g-wrapper/) |
| Surf Excel Easy Wash Detergent Powder | 1 kg | 128.00 | 20 | [Source](https://www.bigbasket.com/pd/40101707/surf-excel-easy-wash-detergent-powder-1-kg/) |
| Harpic Power Plus Original Toilet Cleaner | 500 ml | 110.00 | 15 | [Source](https://www.bigbasket.com/pd/263754/harpic-power-plus-disinfectant-toilet-cleaner-liquid-original-500-ml/) |
| Dettol Original Bathing Bar Soap | 125 g | 67.00 | 40 | [Source](https://www.bigbasket.com/pd/100008548/dettol-original-bathing-soap-bar-with-76-tfm-protects-from-germs-125-g/) |
| Colgate Strong Teeth Anticavity Toothpaste | 200 g | 125.00 | 25 | [Source](https://www.bigbasket.com/pd/263921/colgate-strong-teeth-anticavity-toothpaste-with-amino-shakti-formula-provides-fresher-breath-200-g/) |
| bb Royal Thick Poha | 500 g | 38.00 | 22 | [Source](https://www.bigbasket.com/pd/10000453/bb-royal-poha-avalakkiavalchivda-thick-500-g-pouch/) |
| fresho! Onion | 1 kg | 76.00 | 35 | [Source](https://www.bigbasket.com/pd/10000148/fresho-onion-1-kg/) |
| fresho! New Potato | 1 kg | 17.00 | 40 | [Source](https://www.bigbasket.com/pd/40320936/fresho-potato-fresh-crop-1-kg/) |
| fresho! Local Tomato | 1 kg | 50.00 | 1 | [Source](https://www.bigbasket.com/pd/10000203/fresho-tomato-local-1-kg/) |
| fresho! Robusta Banana | 1 kg | 57.00 | 0 | [Source](https://www.bigbasket.com/pd/10000025/fresho-banana-robusta-1-kg/) |
| Aashirvaad Whole Wheat Atta | 5 kg | 281.22 | 20 | [Source](https://www.bigbasket.com/pd/126903/aashirvaad-atta-whole-wheat-5-kg-pouch/) |
| Tata Salt Vacuum Evaporated Iodised Salt | 1 kg | 28.00 | 50 | [Source](https://www.bigbasket.com/pd/241600/tata-salt-iodized-1-kg-pouch/) |
| Fortune Sunlite Refined Sunflower Oil | 870 g | 194.78 | 18 | [Source](https://www.bigbasket.com/pd/40161771/fortune-sunflower-oil-1-l-bottle/) |
| Tata Sampann Unpolished Toor Dal | 1 kg | 178.00 | 25 | [Source](https://www.bigbasket.com/pd/40000291/tata-sampann-unpolished-toor-dalarhar-dal-1-kg-pouch/) |
| bb Royal Sulphurless Refined Sugar | 1 kg | 60.00 | 40 | [Source](https://www.bigbasket.com/pd/10000447/bb-royal-refined-sugar-sulphurless-1-kg/) |
| Tata Sampann Unpolished Split Moong Dal | 500 g | 89.00 | 1 | [Source](https://www.bigbasket.com/pd/30007756/tata-sampann-unpolished-moong-dal-split-500-g-pouch/) |
| Amul Taaza Homogenised Toned Milk | 1 l | 73.00 | 24 | [Source](https://www.bigbasket.com/pd/306926/amul-homogenised-toned-milk-1-l-carton/) |
