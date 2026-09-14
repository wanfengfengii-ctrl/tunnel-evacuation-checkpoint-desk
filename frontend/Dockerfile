FROM node:22-alpine AS build
WORKDIR /app
# The web image builds the static bundle only; it never needs Playwright
# browsers (they belong to the one-shot verify service).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
