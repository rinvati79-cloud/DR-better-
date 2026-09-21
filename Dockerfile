FROM node:22-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev
5 | COPY server.js ./
COPY index.html ./public/index.html
EXPOSE 3000
CMD ["node","server.js"]
