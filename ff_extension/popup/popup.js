//
// Send message to background script to make it aware that popup is open
// Background responds with current lyrics
////
// Send message to background script to make it aware that popup is open
// Background responds with current lyrics
//

// Attempt to connect to background script
let port = browser.runtime.connect({name:"popup-port"});
// Send message to let background script know popup is ready
port.postMessage({ready: true});

// Listen to response from background script
port.onMessage.addListener(function(m) {
  console.log("Recieved lyrics")
  // Set html paragraph to contain lyrics
  document.getElementById("artist").innerText = m.artist;
  document.getElementById("title").innerText = m.title;
  let found = false
  if (m.geniusLyrics !== '') {
    document.getElementById("lyrics").innerText = m.geniusLyrics;
    document.getElementById("provider").innerText = "Provided by Genius";
    found = true 
  }
  if (m.azLyrics !== '' && !found) {
    document.getElementById("lyrics").innerText = m.azLyrics;
    document.getElementById("provider").innerText = "Provided by AZLyrics";
    found = true 
  }
  if (m.absoluteLyrics !== '' && !found) {
    document.getElementById("lyrics").innerText = m.absoluteLyrics;
    document.getElementById("provider").innerText = "Provided by AbsoluteLyrics";
    found = true 
  }
  if (!found) {
    document.getElementById("lyrics").innerText = "No lyrics found";
  }
});
