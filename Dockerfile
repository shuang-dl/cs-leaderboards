FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js db.js index.html ./
EXPOSE 8080
CMD ["node", "server.js"]
