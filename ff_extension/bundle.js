(function () {
    'use strict';

    /**
     * Copyright 2017 Google Inc. All Rights Reserved.
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *     http://www.apache.org/licenses/LICENSE-2.0
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     */
    const Comlink = (function () {
        const TRANSFERABLE_TYPES = [ArrayBuffer, MessagePort];
        const uid = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        const proxyValueSymbol = Symbol("proxyValue");
        const throwSymbol = Symbol("throw");
        const proxyTransferHandler = {
            canHandle: (obj) => obj && obj[proxyValueSymbol],
            serialize: (obj) => {
                const { port1, port2 } = new MessageChannel();
                expose(obj, port1);
                return port2;
            },
            deserialize: (obj) => {
                return proxy(obj);
            }
        };
        const throwTransferHandler = {
            canHandle: (obj) => obj && obj[throwSymbol],
            serialize: (obj) => obj.toString() + "\n" + obj.stack,
            deserialize: (obj) => {
                throw Error(obj);
            }
        };
        /* export */ const transferHandlers = new Map([
            ["PROXY", proxyTransferHandler],
            ["THROW", throwTransferHandler]
        ]);
        let pingPongMessageCounter = 0;
        /* export */ function proxy(endpoint, target) {
            if (isWindow(endpoint))
                endpoint = windowEndpoint(endpoint);
            if (!isEndpoint(endpoint))
                throw Error("endpoint does not have all of addEventListener, removeEventListener and postMessage defined");
            activateEndpoint(endpoint);
            return cbProxy(async (irequest) => {
                let args = [];
                if (irequest.type === "APPLY" || irequest.type === "CONSTRUCT")
                    args = irequest.argumentsList.map(wrapValue);
                const response = await pingPongMessage(endpoint, Object.assign({}, irequest, { argumentsList: args }), transferableProperties(args));
                const result = response.data;
                return unwrapValue(result.value);
            }, [], target);
        }
        /* export */ function proxyValue(obj) {
            obj[proxyValueSymbol] = true;
            return obj;
        }
        /* export */ function expose(rootObj, endpoint) {
            if (isWindow(endpoint))
                endpoint = windowEndpoint(endpoint);
            if (!isEndpoint(endpoint))
                throw Error("endpoint does not have all of addEventListener, removeEventListener and postMessage defined");
            activateEndpoint(endpoint);
            attachMessageHandler(endpoint, async function (event) {
                if (!event.data.id || !event.data.callPath)
                    return;
                const irequest = event.data;
                let that = await irequest.callPath
                    .slice(0, -1)
                    .reduce((obj, propName) => obj[propName], rootObj);
                let obj = await irequest.callPath.reduce((obj, propName) => obj[propName], rootObj);
                let iresult = obj;
                let args = [];
                if (irequest.type === "APPLY" || irequest.type === "CONSTRUCT")
                    args = irequest.argumentsList.map(unwrapValue);
                if (irequest.type === "APPLY") {
                    try {
                        iresult = await obj.apply(that, args);
                    }
                    catch (e) {
                        iresult = e;
                        iresult[throwSymbol] = true;
                    }
                }
                if (irequest.type === "CONSTRUCT") {
                    try {
                        iresult = new obj(...args); // eslint-disable-line new-cap
                        iresult = proxyValue(iresult);
                    }
                    catch (e) {
                        iresult = e;
                        iresult[throwSymbol] = true;
                    }
                }
                if (irequest.type === "SET") {
                    obj[irequest.property] = irequest.value;
                    // FIXME: ES6 Proxy Handler `set` methods are supposed to return a
                    // boolean. To show good will, we return true asynchronously ¯\_(ツ)_/¯
                    iresult = true;
                }
                iresult = makeInvocationResult(iresult);
                iresult.id = irequest.id;
                return endpoint.postMessage(iresult, transferableProperties([iresult]));
            });
        }
        function wrapValue(arg) {
            // Is arg itself handled by a TransferHandler?
            for (const [key, transferHandler] of transferHandlers) {
                if (transferHandler.canHandle(arg)) {
                    return {
                        type: key,
                        value: transferHandler.serialize(arg)
                    };
                }
            }
            // If not, traverse the entire object and find handled values.
            let wrappedChildren = [];
            for (const item of iterateAllProperties(arg)) {
                for (const [key, transferHandler] of transferHandlers) {
                    if (transferHandler.canHandle(item.value)) {
                        wrappedChildren.push({
                            path: item.path,
                            wrappedValue: {
                                type: key,
                                value: transferHandler.serialize(item.value)
                            }
                        });
                    }
                }
            }
            for (const wrappedChild of wrappedChildren) {
                const container = wrappedChild.path
                    .slice(0, -1)
                    .reduce((obj, key) => obj[key], arg);
                container[wrappedChild.path[wrappedChild.path.length - 1]] = null;
            }
            return {
                type: "RAW",
                value: arg,
                wrappedChildren
            };
        }
        function unwrapValue(arg) {
            if (transferHandlers.has(arg.type)) {
                const transferHandler = transferHandlers.get(arg.type);
                return transferHandler.deserialize(arg.value);
            }
            else if (isRawWrappedValue(arg)) {
                for (const wrappedChildValue of arg.wrappedChildren || []) {
                    if (!transferHandlers.has(wrappedChildValue.wrappedValue.type))
                        throw Error(`Unknown value type "${arg.type}" at ${wrappedChildValue.path.join(".")}`);
                    const transferHandler = transferHandlers.get(wrappedChildValue.wrappedValue.type);
                    const newValue = transferHandler.deserialize(wrappedChildValue.wrappedValue.value);
                    replaceValueInObjectAtPath(arg.value, wrappedChildValue.path, newValue);
                }
                return arg.value;
            }
            else {
                throw Error(`Unknown value type "${arg.type}"`);
            }
        }
        function replaceValueInObjectAtPath(obj, path, newVal) {
            const lastKey = path.slice(-1)[0];
            const lastObj = path
                .slice(0, -1)
                .reduce((obj, key) => obj[key], obj);
            lastObj[lastKey] = newVal;
        }
        function isRawWrappedValue(arg) {
            return arg.type === "RAW";
        }
        function windowEndpoint(w) {
            if (self.constructor.name !== "Window")
                throw Error("self is not a window");
            return {
                addEventListener: self.addEventListener.bind(self),
                removeEventListener: self.removeEventListener.bind(self),
                postMessage: (msg, transfer) => w.postMessage(msg, "*", transfer)
            };
        }
        function isEndpoint(endpoint) {
            return ("addEventListener" in endpoint &&
                "removeEventListener" in endpoint &&
                "postMessage" in endpoint);
        }
        function activateEndpoint(endpoint) {
            if (isMessagePort(endpoint))
                endpoint.start();
        }
        function attachMessageHandler(endpoint, f) {
            // Checking all possible types of `endpoint` manually satisfies TypeScript’s
            // type checker. Not sure why the inference is failing here. Since it’s
            // unnecessary code I’m going to resort to `any` for now.
            // if(isWorker(endpoint))
            //   endpoint.addEventListener('message', f);
            // if(isMessagePort(endpoint))
            //   endpoint.addEventListener('message', f);
            // if(isOtherWindow(endpoint))
            //   endpoint.addEventListener('message', f);
            endpoint.addEventListener("message", f);
        }
        function detachMessageHandler(endpoint, f) {
            // Same as above.
            endpoint.removeEventListener("message", f);
        }
        function isMessagePort(endpoint) {
            return endpoint.constructor.name === "MessagePort";
        }
        function isWindow(endpoint) {
            // TODO: This doesn’t work on cross-origin iframes.
            // return endpoint.constructor.name === 'Window';
            return ["window", "length", "location", "parent", "opener"].every(prop => prop in endpoint);
        }
        /**
         * `pingPongMessage` sends a `postMessage` and waits for a reply. Replies are
         * identified by a unique id that is attached to the payload.
         */
        function pingPongMessage(endpoint, msg, transferables) {
            const id = `${uid}-${pingPongMessageCounter++}`;
            return new Promise(resolve => {
                attachMessageHandler(endpoint, function handler(event) {
                    if (event.data.id !== id)
                        return;
                    detachMessageHandler(endpoint, handler);
                    resolve(event);
                });
                // Copy msg and add `id` property
                msg = Object.assign({}, msg, { id });
                endpoint.postMessage(msg, transferables);
            });
        }
        function cbProxy(cb, callPath = [], target = function () { }) {
            return new Proxy(target, {
                construct(_target, argumentsList, proxy) {
                    return cb({
                        type: "CONSTRUCT",
                        callPath,
                        argumentsList
                    });
                },
                apply(_target, _thisArg, argumentsList) {
                    // We use `bind` as an indicator to have a remote function bound locally.
                    // The actual target for `bind()` is currently ignored.
                    if (callPath[callPath.length - 1] === "bind")
                        return cbProxy(cb, callPath.slice(0, -1));
                    return cb({
                        type: "APPLY",
                        callPath,
                        argumentsList
                    });
                },
                get(_target, property, proxy) {
                    if (property === "then" && callPath.length === 0) {
                        return { then: () => proxy };
                    }
                    else if (property === "then") {
                        const r = cb({
                            type: "GET",
                            callPath
                        });
                        return Promise.resolve(r).then.bind(r);
                    }
                    else {
                        return cbProxy(cb, callPath.concat(property), _target[property]);
                    }
                },
                set(_target, property, value, _proxy) {
                    return cb({
                        type: "SET",
                        callPath,
                        property,
                        value
                    });
                }
            });
        }
        function isTransferable(thing) {
            return TRANSFERABLE_TYPES.some(type => thing instanceof type);
        }
        function* iterateAllProperties(value, path = [], visited = null) {
            if (!value)
                return;
            if (!visited)
                visited = new WeakSet();
            if (visited.has(value))
                return;
            if (typeof value === "string")
                return;
            if (typeof value === "object")
                visited.add(value);
            if (ArrayBuffer.isView(value))
                return;
            yield { value, path };
            const keys = Object.keys(value);
            for (const key of keys)
                yield* iterateAllProperties(value[key], [...path, key], visited);
        }
        function transferableProperties(obj) {
            const r = [];
            for (const prop of iterateAllProperties(obj)) {
                if (isTransferable(prop.value))
                    r.push(prop.value);
            }
            return r;
        }
        function makeInvocationResult(obj) {
            for (const [type, transferHandler] of transferHandlers) {
                if (transferHandler.canHandle(obj)) {
                    const value = transferHandler.serialize(obj);
                    return {
                        value: { type, value }
                    };
                }
            }
            return {
                value: {
                    type: "RAW",
                    value: obj
                }
            };
        }
        return { proxy, proxyValue, transferHandlers, expose };
    })();

    let song = {
        artist: '',
        title: '',
        // Lyric results. Could be in an array, but there are some worries about concurrent read/write
        azLyrics: '',
        geniusLyrics: '',
        // lyricFinderLyrics: '',
        absoluteLyrics: '',
    }

    function findMatchingHref(hrefs, stringToFind) {
        for(var value of hrefs.values()) { 
            if (value.textContent === stringToFind) {
                return value.getAttribute("href")
            }
        }
    }

    function findFuzzyHref(hrefs, stringToFind) {
        for(var value of hrefs.values()) { 
            if (value.textContent.includes(stringToFind)) {
                return value.getAttribute("href")
            }
        }
    }

    function findHref(hrefs, stringToFind) {
        let match = findMatchingHref(hrefs, stringToFind)
        if (match === "" || match === null || match === undefined) {
            match = findFuzzyHref(hrefs, stringToFind)
        }
        return match
    }

    // Main Function to start crawling workers
    function setLyrics() {
        const worker = new Worker('./node_modules/comlink-fetch/src/fetch.worker.js');
        const proxy = Comlink.proxy(worker);
        let parser = new DOMParser();

        async function getAzLyrics() {
            // Set up basic informarion for AzLyrics
            const API = await new proxy.Fetch;
            API.setBaseUrl("https://www.azlyrics.com/");
            API.setDefaultHeaders({ 'Content-Type': 'text/html' });
            API.setDefaultBody({ lang: 'en' });

            // Fudge it a bit by starting at directory for artists with that begin with the same letter
            // This is done to make the searching faster, as searching through the whole 
            // site would be same routine just much more intensive
            let artistFirstLetter = song.artist.charAt(0).toLowerCase()
            let artistFirstLetterPageStub = artistFirstLetter + '.html'
            let artistFirstLetterPage = await API.get(artistFirstLetterPageStub)

            // Get all links to all artists
            let doc = parser.parseFromString(artistFirstLetterPage, "text/html")
            let hrefs = doc.querySelectorAll('a[href^="' + artistFirstLetter + '/"]');

            // First, check if we get an exact match for the artist name
            // If not, see if we can get a link that includes the artist name (more of a fuzzy match)
            let artistSongPageStub = findHref(hrefs, song.artist)

            // Get all links for all the songs by the artist
            let artistSongPage = await API.get(artistSongPageStub)
            doc = parser.parseFromString(artistSongPage, "text/html")
            hrefs = doc.querySelectorAll('a[href^="../lyrics/"]');

            // First, check if we get an exact match for the song name
            // If not, see if we can get a link that includes the song name (more of a fuzzy match)
            let lyricPageStub = findHref(hrefs, song.title)

            // Extract out lyrics with some CSS trickery
            let lyricPage = await API.get(lyricPageStub)
            doc = parser.parseFromString(lyricPage, "text/html")
            let lyricsBlock = doc.getElementsByClassName('col-xs-12 col-lg-8 text-center');
            let extractedLyrics = lyricsBlock[0].children[7].innerText;
            song.azLyrics = extractedLyrics;
        }

        async function getGeniusLyrics() {
            // Set up basic informarion for Genius
            const API = await new proxy.Fetch;
            API.setBaseUrl("https://genius.com/");
            API.setDefaultHeaders({ 'Content-Type': 'text/html' });
            API.setDefaultBody({ lang: 'en' });

            // Fudge it a bit by starting at directory for artists with that begin with the same letter
            // This is done to make the searching faster, as searching through the whole 
            // site would be same routine just much more intensive
            let artistFirstLetter = song.artist.charAt(0).toLowerCase()
            let artistFirstLetterPageStub = 'artists-index/' + artistFirstLetter
            let artistFirstLetterPage = await API.get(artistFirstLetterPageStub)

            // Get all links to all artists
            let doc = parser.parseFromString(artistFirstLetterPage, "text/html")
            let hrefs = doc.querySelectorAll('a[href^="https://genius.com/artists/"]');

            // First, check if we get an exact match for the artist name
            // If not, see if we can get a link that includes the artist name (more of a fuzzy match)
            let artistSongPageStub = findHref(hrefs, song.artist)

            // Get all links for all the songs by the artist
            let artistSongPage = await API.get(artistSongPageStub)
            doc = parser.parseFromString(artistSongPage, "text/html")
            hrefs = doc.querySelectorAll('a.mini_card');

            // First, check if we get an exact match for the song name
            // If not, see if we can get a link that includes the song name (more of a fuzzy match)
            // Done differently from other sites as data is organized in a much more nested way
            let lyricPageStub
            for(var value of hrefs.values()) { 
                let cardTitle = value.querySelector('div.mini_card-title');
                if (cardTitle.textContent === song.title) {
                    lyricPageStub = value.getAttribute("href")
                }
            }
            if (lyricPageStub === "" || lyricPageStub === null || lyricPageStub === undefined) {
                for(var value of hrefs.values()) { 
                    let cardTitle = value.querySelector('div.mini_card-title');
                    if (cardTitle.textContent.includes(song.title)) {
                        lyricPageStub = value.getAttribute("href")
                    }
                }
            }

            // Extract out lyrics with some CSS trickery
            let lyricPage = await API.get(lyricPageStub)
            doc = parser.parseFromString(lyricPage, "text/html")
            let lyricsBlock = doc.getElementsByTagName('p');
            let extractedLyrics = lyricsBlock[0].innerText;
            song.geniusLyrics = extractedLyrics;
        }

        //
        // NOTE: Site is far too slow and unorganized to crawl
        //
        async function getLyricFinderLyrics() {
            // Set up basic informarion for LyricFinder
            const API = await new proxy.Fetch;
            API.setBaseUrl("https://www.lyricfinder.org/");
            API.setDefaultHeaders({ 'Content-Type': 'text/html' });
            API.setDefaultBody({ lang: 'en' });

            // Fudge it a bit by starting at directory for artists with that begin with the same letter
            // This is done to make the searching faster, as searching through the whole 
            // site would be same routine just much more intensive
            let artistFirstLetter = song.artist.charAt(0).toUpperCase()
            let artistFirstLetterPageStub = 'search/a-z/' + artistFirstLetter
            let artistFirstLetterPage = await API.get(artistFirstLetterPageStub)

            // Get all links to all artists
            let doc = parser.parseFromString(artistFirstLetterPage, "text/html")
            let hrefs = doc.querySelectorAll('a[href^="/artist/"]');

            // First, check if we get an exact match for the artist name
            // If not, see if we can get a link that includes the artist name (more of a fuzzy match)
            let artistSongPageStub = findHref(hrefs, song.artist)
            artistSongPageStub = artistSongPageStub.toString().replace(/\s/g,'').substring(1)

            // Get all links for all the songs by the artist
            let artistSongPage = await API.get(artistSongPageStub)
            doc = parser.parseFromString(artistSongPage, "text/html")
            hrefs = doc.querySelectorAll('a[href^="/lyrics/"]');
            console.log(hrefs.length)

            // More thorough search through each album, however, this quickly creates too many web workers
            // let lyricPageStub
            // for(let value of hrefs.values()) {
            //     let albumPage = await API.get(value.getAttribute("href"))
            //     doc = parser.parseFromString(albumPage, "text/html")
            //     let trackHrefs = doc.querySelectorAll('a[href^="/search/tracks/"]');
            //     let workingLyricPageStub = findHref(trackHrefs, song.title)
            //     if (workingLyricPageStub !== "" || workingLyricPageStub !== null || workingLyricPageStub !== undefined) {
            //         lyricPageStub = workingLyricPageStub
            //     }
            // }

            // First, check if we get an exact match for the song name
            // If not, see if we can get a link that includes the song name (more of a fuzzy match)
            let lyricPageStub
            for(var value of hrefs.values()) { 
                console.log("value" , value.innerText)
                let cardTitle = value.querySelector('div.mini_card-title');
                if (cardTitle.textContent === song.title) {
                    lyricPageStub = value.getAttribute("href")
                }
            }
            if (lyricPageStub === "" || lyricPageStub === null || lyricPageStub === undefined) {
                for(var value of hrefs.values()) { 
                    let cardTitle = value.querySelector('div.mini_card-title');
                    if (cardTitle.textContent.includes(song.title)) {
                        lyricPageStub = value.getAttribute("href")
                    }
                }
            }


            // Extract out lyrics with some CSS trickery
            let lyricPage = await API.get(lyricPageStub)
            console.log("lyricPage", lyricPage.toString())
            doc = parser.parseFromString(lyricPage, "text/html")
            let lyricsBlock = doc.getElementsByClassName('col-lg-6');
            let extractedLyrics = lyricsBlock[0].children[7].innerText;
            song.lyricFinderLyrics = extractedLyrics;
        }


        async function getAbsoluteLyrics() {
            // Set up basic informarion for AzLyrics
            const API = await new proxy.Fetch;
            API.setBaseUrl("http://www.absolutelyrics.com/");
            API.setDefaultHeaders({ 'Content-Type': 'text/html' });
            API.setDefaultBody({ lang: 'en' });

            // Fudge it a bit by starting at directory for artists with that begin with the same letter
            // This is done to make the searching faster, as searching through the whole 
            // site would be same routine just much more intensive
            let artistFirstLetter = song.artist.charAt(0).toLowerCase()
            // NOTE: Cannot reliably click through pages, so just search first 3
            // Not done in a for loop because async JS and for loops do not play well
            let artistFirstLetterPageStub = 'lyrics/artistlist/' + artistFirstLetter
            let artistFirstLetterPageStub2 = 'lyrics/artistlist/' + artistFirstLetter + '/2'
            let artistFirstLetterPageStub3 = 'lyrics/artistlist/' + artistFirstLetter + '/3'
            let artistFirstLetterPage = await API.get(artistFirstLetterPageStub)
            let artistFirstLetterPage2 = await API.get(artistFirstLetterPageStub2)
            let artistFirstLetterPage3 = await API.get(artistFirstLetterPageStub3)

            // Get all links to all artists
            let doc = parser.parseFromString(artistFirstLetterPage, "text/html")
            let hrefs = doc.querySelectorAll('a[href^="/lyrics/artist/"]');
            let doc2 = parser.parseFromString(artistFirstLetterPage2, "text/html")
            let hrefs2 = doc2.querySelectorAll('a[href^="/lyrics/artist/"]');
            let doc3 = parser.parseFromString(artistFirstLetterPage3, "text/html")
            let hrefs3 = doc3.querySelectorAll('a[href^="/lyrics/artist/"]');

            // First, check if we get an exact match for the artist name
            // If not, see if we can get a link that includes the artist name (more of a fuzzy match)
            let artistSongPageStub = findHref(hrefs, song.artist)
            let artistSongPageStub2 = findHref(hrefs2, song.artist)
            let artistSongPageStub3 = findHref(hrefs3, song.artist)

            let foundStub
            if (artistSongPageStub !== undefined) {
                foundStub = artistSongPageStub
            }
            if (artistSongPageStub2 !== undefined) {
                foundStub = artistSongPageStub2
            }
            if (artistSongPageStub3 !== undefined) {
                foundStub = artistSongPageStub3
            }

            // Get all links for all the songs by the artist
            let artistSongPage = await API.get(foundStub.toString().replace(/\s/g,'').substring(1))
            doc = parser.parseFromString(artistSongPage, "text/html")
            hrefs = doc.querySelectorAll('a[href^="/lyrics/view/"]');

            // First, check if we get an exact match for the song name
            // If not, see if we can get a link that includes the song name (more of a fuzzy match)
            let lyricPageStub = findHref(hrefs, song.title)

            // Extract out lyrics with some CSS trickery
            let lyricPage = await API.get(lyricPageStub.toString().replace(/\s/g,'').substring(1))
            doc = parser.parseFromString(lyricPage, "text/html")
            let lyricsBlock = doc.getElementById('view_lyrics');
            let extractedLyrics = lyricsBlock.innerText;
            song.absoluteLyrics = extractedLyrics;
        }

        getAzLyrics()
        getGeniusLyrics()
        // getLyricFinderLyrics()
        getAbsoluteLyrics()
    }


    //
    // Receive video information from content script to fetch relevant lyrics
    // Watch browser history to determine if a YouTube video is being watched
    //
    browser.webNavigation.onHistoryStateUpdated.addListener(
      (history) => {
        const url = new URL(history.url);
        if (!url.searchParams.get('v')) {
          // Not a video
          return;
        }
        // Send message to content script telling it a new video is being played
        browser.tabs.sendMessage(history.tabId, { videoChanged: true });
      },
      { url: [{ urlMatches: '^https://www.youtube.com/watch?' }] }
    );

    // Listen to message from content script for YouTube video details
    browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        song.artist = request.artist
        song.title = request.title
        setLyrics();
    });

    //
    // Listen to popup being opened and forward current lyrics
    //
    browser.runtime.onConnect.addListener(port => {
        port.onMessage.addListener(function(m) {
        console.log('Got connection from popup');
        // If port is ready, respond with lyrics
        if (m.ready) {
            port.postMessage(song);
        }
        });
    });

}());
