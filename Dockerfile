FROM node:18-alpine

# Added ffmpeg for lightning-fast Animated WebP encoding
RUN apk add --no-cache git tzdata ffmpeg

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 8090
CMD [ "node", "app.js" ]