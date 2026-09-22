# DR Better Pages

अब pages अलग हैं:
- `index.html` = केवल Home/App
- `login.html` = केवल Login
- `signup.html` = केवल Sign Up
- `assets/` = सभी images
- `Dockerfile` = Render deployment

Login/Sign Up सफल होने के बाद `index.html` Home खुलेगा।
Logout करने पर `login.html` खुलेगा।

Render में repository root के अंदर `dbwork` हो तो Root Directory `dbwork` रखें।
Dockerfile Path `./Dockerfile` और Docker Context `.` रखें।
