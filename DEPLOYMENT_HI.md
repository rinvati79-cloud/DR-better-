# DR Better — REAL ONLY deployment guide

यह build **demo/local fallback के बिना** है। Register/Login तभी काम करेगा जब API + PostgreSQL चल रहे हों।

## 1) Local test
1. इस `dbwork` folder में `.env.example` की copy बनाकर `.env` करें।
2. `POSTGRES_PASSWORD` और `JWT_SECRET` में मजबूत values डालें।
3. चलाएँ:
   `docker compose up --build -d`
4. API health:
   `http://localhost:3000/api/health`
5. App:
   `http://localhost:3000`

## 2) Online users के लिए
आपको Docker-capable hosting पर यह `dbwork` service deploy करनी होगी और PostgreSQL को persistent database के रूप में रखना होगा।

Production में:
- HTTPS domain लगाएँ।
- `FRONTEND_ORIGIN` को उसी exact app origin पर सेट करें।
- `DATABASE_URL` को production PostgreSQL से जोड़ें।
- `DATABASE_SSL=true` करें यदि provider SSL मांगता है।
- `JWT_SECRET` को secret/environment variable में रखें।
- `.env` को public repository में upload न करें।

## 3) Mobile/Hopwep से खोलना
सिर्फ ZIP को mobile editor में खोलने से PostgreSQL backend online नहीं होता। App को **deployed backend URL** से serve करना जरूरी है। इस build में frontend और API एक ही Express server से serve होते हैं, इसलिए अलग frontend URL की जरूरत नहीं है।

## 4) Real wallet
Wallet database-backed है और शुरुआत ₹0 से होती है। Real money credit/debit के लिए अलग payment provider और server-side webhook verification जोड़ना होगा। Frontend से balance बदलने की अनुमति नहीं है।

## 5) Important
यह package backend-ready है; मैं इस chat से आपके लिए कोई external hosting account, database account या payment account खुद create/deploy नहीं कर सकता। Deployment के बाद Register button वास्तविक PostgreSQL account बनाएगा।
