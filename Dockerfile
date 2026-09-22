FROM node:22-slim
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force
COPY server/src server/src
COPY public public
ENV NODE_ENV=production DATA_DIR=/data PUBLIC_DIR=/app/public PORT=3000
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
