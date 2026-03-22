FROM oven/bun:1.2-alpine

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install production deps only
RUN bun install --frozen-lockfile --production

# Copy relay + SDK source
COPY relay/ ./relay/
COPY src/sdk/ ./src/sdk/
COPY src/types.ts ./src/types.ts
COPY src/prover.ts ./src/prover.ts
COPY circuits/build/loyalty_verify_js/ ./circuits/build/loyalty_verify_js/
COPY circuits/build/loyalty_verify_final.zkey ./circuits/build/loyalty_verify_final.zkey
COPY circuits/build/verification_key.json ./circuits/build/verification_key.json

EXPOSE 3100

CMD ["bun", "run", "relay/index.ts"]
