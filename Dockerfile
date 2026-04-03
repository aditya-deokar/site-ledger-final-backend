# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies needed for build
COPY package*.json ./
RUN npm install

# Copy source and prisma
COPY ./src ./src
COPY ./prisma ./prisma
COPY tsconfig.json ./

# Generate Prisma client and build the app
RUN npx prisma generate
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# NEW: Install OpenSSL for Prisma
RUN apk add --no-cache openssl libc6-compat

# Copy only what is needed for production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 5000

CMD ["node", "dist/server.js"]
