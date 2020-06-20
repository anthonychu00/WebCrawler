# WebCrawler for Professor Tseng's Networks Class
A Firefox Extension Project utilizing Web Crawling Algorithm with Web Workers

**TO RUN LOCALLY**
- Install Firefox: https://www.mozilla.org/en-US/firefox/new/
- Install web-ext: https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/
- Clone this repo
- Change to `ff_extension` directory
- Run `web-ext run`; A sandboxed Firefox window should popup
- Visit YouTube.com
- Watch any music video with a title formatted `ARTIST NAME - SONG TITLE`
- Click the light blue music note in top right corner to view lyrics

**In case it does not work**
- For development, we required NPM (to get web workers fetching in a browser extension), however it should not be required for merely using it
- Install NPM: https://www.npmjs.com/get-npm
- Run `npm install` in the `ff_extension` directory
