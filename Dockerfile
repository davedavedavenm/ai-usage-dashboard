FROM node:22-alpine
WORKDIR /app
COPY server.js .
COPY public ./public
ENV PORT=8099
EXPOSE 8099
USER node
CMD ["node", "server.js"]
