# One image for both Railway services:
#   api  → start command: npm start      (default)
#   ai   → start command: npm run ai
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY . .
# No runtime dependencies to install: the app uses only Node built-ins.
EXPOSE 8787
CMD ["npm", "start"]
