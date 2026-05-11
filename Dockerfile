FROM oven/bun:1

WORKDIR /app

# Install dev deps first (only @types/bun for now) so this layer caches.
COPY package.json ./
RUN bun install

# Source is mounted at runtime; nothing else to copy here.
