FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.cjs whatsapp.cjs ai-chain.cjs ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.cjs"]
