//
// Getters for song information
// Note: Prefer classes as IDs are not used and classes are very specific
//

// Class consts
const titleClass = "title style-scope ytd-video-primary-info-renderer"

// Helper for removing all text after and including the occurence of the sub string
function removeAfterOccurence(origStr, subStr){
  let result = origStr
  let index = origStr.indexOf(subStr)
  if (index != -1) {
    result = origStr.substring(0, index) 
  }
  return result
}

// Just repeats the above for cleaner code
function removeAfterOccurences(origStr, subStrs) {
  subStrs.forEach(subStr => {
    origStr = removeAfterOccurence(origStr, subStr)
  });
  return origStr
}

// Find song artist and title from video title
// NOTE: Only works for video title formatted as "ARTIST - SONG" 
function getVideoTitle() {
  // Find video title from class
  let vidTitle = document.getElementsByClassName(titleClass)[0].innerText;
  
  // Remove pesky quotes in title
  vidTitle = vidTitle.replace(/\"/g, '')
  // Remove anything in quotes or brackets (This is usually something like (Official Music Video))
  vidTitle = removeAfterOccurences(vidTitle, ["(", "["])

  // Split the video into two parts, the artist and song title
  let titleArray = vidTitle.split("-", 2)
  let songDetails = {
    artist: titleArray[0],
    title: titleArray[1],
  }

  // Remove any features as they clog the crawler and trim white space
  songDetails.artist  = removeAfterOccurences(songDetails.artist , [",", "ft.", "Ft.", "feat.", "Feat."])
  songDetails.artist = songDetails.artist.trim()

  // Remove any features as they clog the crawler and trim white space
  songDetails.title  = removeAfterOccurences(songDetails.title , ["ft.", "Ft.", "feat.", "Feat."])
  songDetails.title = songDetails.title.trim()

  return songDetails
}

//
// Listen for messages from background script, as only it polls for when a new video is played
// 
browser.runtime.onMessage.addListener(message => {
  // Check if video changed
  if (message.videoChanged) {
    console.log("Video changed")
    // Need to wait for title to update 
    // TODO: Replace the wait with something smarter
    setTimeout(() => {
      // Send video information back to backgroundscript
      browser.runtime.sendMessage(getVideoTitle());
    }, 1500);
  }
});