FROM node:20-alpine

# NEW: Install OpenSSL 1.1 dependency for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY ./dist ./dist
COPY ./prisma ./prisma

# Generate Prisma client for alpine binaryTarget
RUN npx prisma generate

EXPOSE 5000

CMD ["node", "dist/server.js"]
