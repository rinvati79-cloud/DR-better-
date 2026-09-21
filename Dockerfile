FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY index.html ./public/index.html
COPY *.jpg ./public/assets/
EXPOSE 3000
CMD ["node","server.js"]
