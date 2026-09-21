# DR Better — Real Database Only

इस build में कोई device-only/demo account fallback नहीं है। Backend उपलब्ध नहीं होने पर Login/Register account नहीं बनाएगा।

## Local server
1. Docker Desktop/Engine चालू करें।
2. `.env.example` को `.env` नाम से copy करें।
3. `.env` में `POSTGRES_PASSWORD` और `JWT_SECRET` के मजबूत values डालें।
4. चलाएँ: `docker compose up --build -d`
5. Browser में `http://localhost:3000` खोलें।
6. Register करके नया real database account बनाएँ।

## Important
- Wallet का शुरुआती balance database में ₹0 है। Real money खुद से credit नहीं होगा।
- Payment gateway अभी अलग चरण में जोड़ना होगा।
- Public/online users के लिए इस server को public HTTPS domain पर deploy करना होगा और `FRONTEND_ORIGIN` को उसी domain पर सेट करना होगा।
- `.env` को public repository में upload न करें।
