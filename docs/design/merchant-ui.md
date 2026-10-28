# Merchant interface design

Reference: `merchant-inventory-concept.png` (1536 × 1024), generated before implementation. STYLE.md controls the implementation.

Public Sans is chosen for clear compact numerals and readable product names. Type scale: 12, 13, 14, 16, 20, 28. White background, neutral sidebar, hairline borders, no flat-panel shadows, 6px controls, 8px dialogs. Forest green is the only brand accent. Semantic warning/destructive colors identify stock states with text. Tokens are OKLCH in the single Tailwind stylesheet. Content padding is 24px desktop / 16px mobile; table rows are compact. Lucide outline icons only.

The desktop reference fixes the sidebar, breadcrumb, heading, four open metrics, stock tabs, search/category/column toolbar, table and pagination. Actual catalog values replace illustration data: prices/SKUs/pack counts in the concept are not authoritative. No thumbnails, charts, marketing cards or retailer links. The stock action is named Adjust stock in all entry points. Inventory, Stock history and Account are the only navigation items. Low stock means 1–5 available packs; out of stock means zero available packs. Reserved packs are displayed separately and cannot be removed by stock adjustment.

Related states use the same system: login/signup/reset forms in a narrow left-aligned column; adjustment in an accessible dialog; compact stock-movement table; account details and pending-access state; mobile drawer navigation with a horizontally scrollable table. Forms use labels, React Hook Form and Zod, inline errors and explicit save feedback. All table data remains code-native.

Required visible copy includes Stockroom, Inventory, Track sellable packs and update stock., Adjust stock, Products, Available packs, Reserved packs, Out of stock, All products, Low stock, Search product, brand or SKU, Category, Columns, Product, SKU, Price, On hand, Reserved, Available, Status, Stock history, Account, Demo store, DEMO-STORE and Sign out. Auth copy: Sign in, Create account, Forgot password, Reset password, Email, Password, Confirm password and Full name.

Intentional reference differences: live product names, prices and totals come from the database; all data is demo store inventory. An explicitly enabled local preview adds a preview notice and changes only browser state. Auth and provider-setup errors must remain clear. On mobile the sidebar becomes a drawer, metric groups wrap and the table scrolls inside its own container. A row's ellipsis opens stock adjustment rather than an empty menu.
