# Ledgerbook Server for the cloud. Developed by Sourabh Tilawat.
FROM node:20-alpine
WORKDIR /app
COPY server/server.js server/package.json ./
COPY app/src/main/assets/www ./www
ENV PORT=8787 LEDGERBOOK_DATA=/data LEDGERBOOK_WWW=/app/www
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
