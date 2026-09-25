FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV PORT=8765 MAX_MB=30 MAX_SEC=600
EXPOSE 8765
CMD ["node", "server.js"]
