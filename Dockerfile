FROM node:18-alpine

RUN apk add --no-cache git tzdata

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 8090
CMD [ "node", "app.js" ]
