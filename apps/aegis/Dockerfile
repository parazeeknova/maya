FROM oven/bun AS build

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY .oxlintrc.json ./
COPY .oxfmtrc.jsonc ./

RUN bun install

COPY public ./public
COPY src ./src

RUN bun run build

FROM nginx:alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
