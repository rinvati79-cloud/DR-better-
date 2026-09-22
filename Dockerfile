FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY schema.sql ./

RUN mkdir -p public/assets

COPY index.html ./public/index.html
COPY login.html ./public/login.html
COPY signup.html ./public/signup.html

COPY banner.jpg ./public/assets/banner.jpg
COPY br_survival.jpg ./public/assets/br_survival.jpg
COPY clash_1v1.jpg ./public/assets/clash_1v1.jpg
COPY clash_4v4.jpg ./public/assets/clash_4v4.jpg
COPY lone_wolf_1v1.jpg ./public/assets/lone_wolf_1v1.jpg
COPY lone_wolf_2v2.jpg ./public/assets/lone_wolf_2v2.jpg
COPY per_kill.jpg ./public/assets/per_kill.jpg

EXPOSE 3000

CMD ["node", "server.js"]
