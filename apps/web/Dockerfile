FROM oven/bun AS build

WORKDIR /app

COPY package.json ./
COPY .oxlintrc.json ./
COPY .oxfmtrc.jsonc ./

RUN bun install

COPY index.ts ./
COPY lib ./lib
COPY public ./public
COPY tsconfig.json ./

RUN bun run build

FROM oven/bun:slim AS runtime

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["bun", "dist/index.js"]
