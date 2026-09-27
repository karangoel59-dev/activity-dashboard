# Stage 1: Build the application
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# Stage 2: Production runtime environment
FROM node:24-alpine

# git is needed in full mode to maintain bare clones of repositories (reftable support needs git >= 2.46)
# curl is added for container health checks
RUN apk add --no-cache git curl

WORKDIR /app

# Copy built application and dependencies
COPY --from=builder /app/build build/
COPY --from=builder /app/node_modules node_modules/
COPY package.json .

# Ensure data directory exists for local mirror and state caching
RUN mkdir -p /app/data

ENV PORT=8080
ENV NODE_ENV=production
ENV BODY_SIZE_LIMIT=0

EXPOSE 8080

CMD ["node", "build/index.js"]
