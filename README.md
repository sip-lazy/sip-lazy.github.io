### Browser WebRTC Phone

A basic browser WebRTC phone utilizing JsSIP for audio and video calls, compatible with the repository's sip_proxy or other standard SIP servers. 

 
While playing around with the repository's sip_proxy, I realized I needed an actual phone to test it. At the same time, I wanted to take GitHub Copilot for a spin and see how fast I could build a simple phone app.

Of course, I know that a serious, production-ready phone should probably have features like:

* Phonebook and contacts management
* Full call history logs
* DTMF keypad support
* Media device selection (mic, speaker, camera)
* Camera toggles during a call
* Browser push notifications for incoming calls
* Screen sharing
* In-call messaging and chat
* Presence status (Online, Away, Busy)
* Multi-call handling (putting people on hold, switching lines)
* Call redirection and transfers
* Audio and video conferencing
* Voicemail access
* Call recording
* Voice recognition
* Auto-configuration (like fetching TURN server credentials automatically)

But... that's not what this test phone is about! This app is intentionally designed to be as simple, basic, and lightweight as possible. 

If you need any features that are missing, feel free to fork the repository and tweak it to your heart's content.


## How to Test the Web Phone

1. **Open the Web Phone:** Launch the live application at [sip-lazy.github.io](https://sip-lazy.github.io) (Google Chrome is highly recommended).
2. **Configure Settings:** Click the menu button (three dashes) in the top-right corner. Enter your **Proxy URL**, **Username**, **Password**, and **STUN/TURN Server URL**.
3. **Set Up a Second Device:** Repeat this process on a completely separate computer using a different account.
4. **Place a Test Call:** Once both instances are configured, you can call from the web phone on one computer to the web phone on the other.

