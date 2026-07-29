let ua = null;
let currentSession = null;
let hasCamera = false;
let isSendingVideo = false;
let isMuted = false;
let localMediaStream = null;
let currentAudio = null;
let currentPlayPromise = null;
let callTimerInterval = null;
let callStartTime = null;
const ringingAudio = new Audio('sounds/ringing.mp3');
const ringbackAudio = new Audio('sounds/ringback.mp3');
const busyAudio = new Audio('sounds/busy.mp3');

document.addEventListener('DOMContentLoaded', main);


async function main() {
    if (!isWebRtcAvailable()) {
        updateStatus('This browser does not support WebRTC.', '#e74c3c');
        return;
    }
    const devices = await checkMediaDevices();
    if (!devices.speaker) {
        updateStatus('Speaker not found. Connect a speaker or headphones and refresh the page.', '#e74c3c');
        return;
    }
    if (!devices.microphone) {
        updateStatus('Microphone not found. Connect a microphone or headphones and refresh the page.', '#e74c3c');
        return;
    }
    hasCamera = devices.camera;
    isSendingVideo = hasCamera;
    console.log(hasCamera ? 'Camera present' : 'No camera');
    updateCallModeButton();

    const phoneInput = document.getElementById('phone-input');

    // Local video sized as 25% of the video container width, maintaining 16:9 ratio
    const pipObserver = new ResizeObserver(([entry]) => {
        const w = Math.round(entry.contentRect.width * 0.25);
        const localVideo = document.getElementById('local-video');
        localVideo.style.width = w + 'px';
        localVideo.style.height = Math.round(w * 9 / 16) + 'px';
    });
    pipObserver.observe(document.getElementById('video-container'));

    // Check if audio autoplay is available; show unlock banner if blocked
    playAudio({ audio: ringingAudio, mute: true, loop: false, repeat: 1 }).then(success => {
        stopAudio();
        if (!success) {
            document.getElementById('audio-unlock-banner').style.display = 'flex';
        }
    });

    // Load saved settings from localStorage on startup
    loadSettings();

    // Automatically connect to the SIP signaling server on startup
    initJsSIP();

    phoneInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            startCall();
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            endCall();
            return;
        }

        if (['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(event.key)) {
            return;
        }

        const allowedRegex = /^[a-zA-Z0-9\s\.@\-*#]$/;
        if (!allowedRegex.test(event.key)) {
            event.preventDefault();
        }
    });
}


async function initJsSIP() {
    JsSIP.debug.enable('JsSIP:*');

    if (ua) {
        if (ua.isConnected()) {
            await new Promise((resolve) => {
                ua.once('disconnected', (e) => {
                    console.log('UA successfully disconnected:', e.reason);
                    resolve(e);
                });
                ua.stop();
            });
        } else {
            ua.stop();
        }
        ua = null;
    }

    const serverUrl = document.getElementById('setting-server').value.trim();
    const username = document.getElementById('setting-username').value.trim();
    const password = document.getElementById('setting-password').value;

    if (!serverUrl || !username) {
        updateStatus('Missing Server or Username', '#e74c3c');
        return;
    }

    let domain;
    try {
        domain = new URL(serverUrl).hostname;
    } catch (e) {
        updateStatus('Invalid Server URL', '#e74c3c');
        return;
    }

    const displayName = document.getElementById('setting-displayname').value.trim();

    const socket = new JsSIP.WebSocketInterface(serverUrl);
    const config = {
        sockets: [socket],
        uri: `sip:${username}@${domain}`,
        password,
        display_name: displayName || undefined,
        register: true
    };

    try {
        ua = new JsSIP.UA(config);

        ua.on('connected', () => {
            console.log('event: connected');
            updateStatus('Connected to Signaling', '#3498db');
        });
        ua.on('disconnected', () => {
            console.log('event: disconnected');
            updateStatus('Disconnected', '#475569');
        });
        ua.on('registered', () => {
            console.log('event: registered');
            updateStatus('Online / Registered', '#2ecc71');
        });
        ua.on('registrationFailed', () => {
            console.log('event: registrationFailed');
            updateStatus('Registration Failed', '#e74c3c');
        });
        ua.on('unregistered', () => {
            console.log('event: unregistered');
            updateStatus('Unregistered', '#e74c3c');
        });

        ua.on('newRTCSession', (data) => {
            console.log('event: newRTCSession');
            const session = data.session;
            if (session.direction === 'incoming') {
                handleIncomingCall(session, data.request);
            } else {
                handleOutgoingCall(session);
            }
        });

        ua.start();
    } catch (err) {
        console.error('JsSIP Initialization Error:', err);
        updateStatus('Initialization Error', '#e74c3c');
    }
}


function handleIncomingCall(session, request) {
    if (currentSession) {
        session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
        return;
    }
    currentSession = session;

    const sdp = request?.body || '';
    const offerHasVideo = sdp.includes('m=video');
    isSendingVideo = offerHasVideo && hasCamera;

    const modeRow = document.getElementById('modal-answer-mode');
    const modeBtn = document.getElementById('modal-mode-toggle');
    if (isSendingVideo) {
        modeBtn.textContent = 'Send Video';
        modeRow.style.display = 'block';
    } else {
        modeRow.style.display = 'none';
    }

    bindSessionEvents(session);
    playAudio({ audio: ringingAudio, loop: true });
    const displayName = session.remote_identity.display_name;
    const user = session.remote_identity.uri.user;
    const remoteIdentity = displayName ? `${displayName} (${user})` : user || 'Unknown Caller';

    document.getElementById('caller-id').innerText = remoteIdentity;
    document.getElementById('incoming-modal').style.display = 'flex';

    updateStatus(`Incoming call from ${remoteIdentity}...`, '#d35400');
}


function acceptIncomingCall() {
    if (!currentSession) return;

    document.getElementById('incoming-modal').style.display = 'none';
    setDialerVisible(false);
    document.getElementById('video-container').style.display = 'block';
    stopAudio();

    const callOptions = {
        mediaConstraints: { audio: true, video: isSendingVideo }
    };
    currentSession.answer(callOptions);
}


function rejectIncomingCall() {
    if (currentSession) {
        currentSession.terminate({ status_code: 603, reason_phrase: 'Decline' }); // 'failed' event will call cleanupCall()
    } else {
        cleanupCall();
    }
}


function handleOutgoingCall(session) {
    currentSession = session;
    setDialerVisible(false);
    bindSessionEvents(session);
    playAudio({ audio: ringbackAudio, loop: true });
    setOutgoingCallUI();
}


function startCall() {
    const input = document.getElementById('phone-input');
    const target = input.value.trim();

    if (!target) {
        updateStatus('Please enter a valid target name or number.', '#475569');
        return;
    }
    if (!ua || !ua.isRegistered()) {
        updateStatus('Cannot call: SIP not registered', '#e74c3c');
        return;
    }

    updateStatus(`Calling ${target}...`, '#d35400');
    stopAudio();
    setDialerVisible(false);
    document.getElementById('video-container').style.display = 'block';
    setOutgoingCallUI();

    let parsedIce = [];
    try {
        parsedIce = JSON.parse(document.getElementById('setting-ice').value);
    } catch (e) {
        console.warn('Invalid ICE configuration string format, fallback default processing.');
    }

    const callOptions = {
        mediaConstraints: getMediaConstraints(),
        pcConfig: {
            iceServers: parsedIce
        }
    };

    const targetUri = (target.includes('@') || target.toLowerCase().startsWith('sip:')) ? target : `sip:${target}@${ua.configuration.uri.host}`;
    ua.call(targetUri, callOptions);
}

function getMediaConstraints() {
    return { audio: true, video: isSendingVideo && hasCamera };
}

function toggleCallMode() {
    if (!hasCamera) return;

    isSendingVideo = !isSendingVideo;
    updateCallModeButton();
}

function toggleAnswerMode() {
    isSendingVideo = !isSendingVideo;
    document.getElementById('modal-mode-toggle').textContent = isSendingVideo ? 'Send Video' : 'Audio Only';
}

function toggleMute() {
    if (!currentSession) return;

    isMuted = !isMuted;
    if (isMuted) {
        currentSession.mute({ audio: true });
    } else {
        currentSession.unmute({ audio: true });
    }

    const btn = document.getElementById('mute-toggle');
    if (btn) {
        btn.textContent = isMuted ? 'Unmute' : 'Mute';
        btn.classList.toggle('btn-muted', isMuted);
    }
}

async function toggleSendVideo() {
    if (!currentSession || !currentSession.connection) return;
    const pc = currentSession.connection;
    const btn = document.getElementById('video-send-toggle');
    const localVideo = document.getElementById('local-video');

    if (isSendingVideo) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
            sender.track.stop();
            pc.removeTrack(sender);
        }
        isSendingVideo = false;
        if (btn) btn.textContent = 'Send Video';
        localVideo.srcObject = null;
        localVideo.classList.add('hidden');
        stopCamera();
        currentSession.renegotiate({});
    } else {
        try {
            stopCamera();
            localMediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const videoTrack = localMediaStream.getVideoTracks()[0];
            pc.addTrack(videoTrack, localMediaStream);
            isSendingVideo = true;
            if (btn) btn.textContent = 'Stop Video';
            localVideo.srcObject = new MediaStream([videoTrack]);
            localVideo.classList.remove('hidden');
            showVideoContainer();
            currentSession.renegotiate({});
        } catch (err) {
            console.error('Failed to access camera:', err);
            updateStatus('Camera access denied', '#e74c3c');
        }
    }
}


function setDialerVisible(visible) {
    const dialer = document.getElementById('dialer-display');
    if (dialer) {
        dialer.style.display = visible ? 'block' : 'none';
    }
}

function updateCallModeButton() {
    const modeButton = document.getElementById('mode-toggle');
    if (!modeButton) return;

    if (!hasCamera) {
        modeButton.style.display = 'none';
        return;
    }

    modeButton.style.display = 'inline-flex';
    modeButton.disabled = false;
    modeButton.textContent = isSendingVideo ? 'Video' : 'Audio';
    modeButton.classList.toggle('is-audio-mode', !isSendingVideo);
    modeButton.setAttribute('aria-pressed', String(isSendingVideo));
}

function setOutgoingCallUI() {
    setCallButtonState(true);
    // During ringing, video-send and mute controls are not yet usable
    const videoSendBtn = document.getElementById('video-send-toggle');
    const muteBtn = document.getElementById('mute-toggle');
    if (videoSendBtn) videoSendBtn.style.display = 'none';
    if (muteBtn) muteBtn.style.display = 'none';
}

function setCallButtonState(active) {
    const actionButton = document.getElementById('call-action');
    const modeButton = document.getElementById('mode-toggle');
    const videoSendBtn = document.getElementById('video-send-toggle');
    if (!actionButton) return;

    const muteBtn = document.getElementById('mute-toggle');
    if (active) {
        actionButton.textContent = 'Stop';
        actionButton.classList.remove('btn-call');
        actionButton.classList.add('btn-stop');
        actionButton.onclick = endCall;
        if (modeButton) modeButton.style.display = 'none';
        if (videoSendBtn && hasCamera) videoSendBtn.style.display = 'inline-block';
        if (muteBtn) muteBtn.style.display = 'inline-block';
    } else {
        actionButton.textContent = 'Call';
        actionButton.classList.remove('btn-stop');
        actionButton.classList.add('btn-call');
        actionButton.onclick = startCall;
        if (modeButton) {
            modeButton.style.display = 'inline-flex';
            updateCallModeButton();
        }
        if (videoSendBtn) videoSendBtn.style.display = 'none';
        if (muteBtn) muteBtn.style.display = 'none';
    }
}

function showVideoContainer() {
    const container = document.getElementById('video-container');
    if (container)
        container.style.display = 'block';
}

function hideVideoContainer() {
    const container = document.getElementById('video-container');
    if (container)
        container.style.display = 'none';
}


function showRemoteVideoContainer() {
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.classList.remove('hidden');
    showVideoContainer();
}

function hideRemoteVideoContainer() {
    const remoteVideo = document.getElementById('remote-video');
    remoteVideo.classList.add('hidden');
    hideVideoContainer();
}


function getRemoteIdentity(session) {
    const displayName = session?.remote_identity?.display_name;
    const user = session?.remote_identity?.uri?.user;
    return displayName ? `${displayName} (${user})` : user || 'Unknown Caller';
}

function formatCallDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function updateActiveCallStatus(session) {
    if (!callStartTime) {
        callStartTime = Date.now();
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - callStartTime) / 1000));
    const remoteIdentity = getRemoteIdentity(session || currentSession);
    updateStatus(`Call in progress • ${formatCallDuration(elapsedSeconds)} • ${remoteIdentity}`, '#2ecc71');
}

function startCallTimer(session) {
    clearCallTimer();
    callStartTime = Date.now();
    updateActiveCallStatus(session);
    callTimerInterval = window.setInterval(() => updateActiveCallStatus(session), 1000);
}

function clearCallTimer() {
    if (callTimerInterval) {
        window.clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    callStartTime = null;
}

function bindSessionEvents(session) {
    session.on('progress', (data) => {
        console.log('[DEBUG] session event "progress"');
        if (session.direction === 'outgoing') {
            updateStatus('Ringing...', '#d35400');
            // Stop ringback if early media arrives (180/183 with SDP)
            if (data.originator === 'remote' && data.response?.body) {
                console.log('early media received, stopping ringback');
                stopAudio();
            }
        }
    });

    session.on('confirmed', () => {
        console.log('[DEBUG] session event "confirmed"');
        stopAudio();
        startCallTimer(session);
        document.getElementById('incoming-modal').style.display = 'none';
        setCallButtonState(true);

        const connection = session.connection;
        const senders = connection ? connection.getSenders() : [];
        const receivers = connection ? connection.getReceivers() : [];

        console.log('[DEBUG] confirmed call data', {
            senders: senders.map(s => ({ kind: s.track?.kind, readyState: s.track?.readyState })),
            receivers: receivers.map(r => ({ kind: r.track?.kind, readyState: r.track?.readyState })),
            localDescription: connection?.localDescription?.type,
            remoteDescription: connection?.remoteDescription?.type
        });

        isSendingVideo = senders.some(s => s.track?.kind === 'video' && s.track?.readyState === 'live');
        const videoSendBtn = document.getElementById('video-send-toggle');
        if (videoSendBtn) videoSendBtn.textContent = isSendingVideo ? 'Stop Video' : 'Send Video';

        const localVideo = document.getElementById('local-video');
        if (isSendingVideo) {
            localVideo.srcObject = new MediaStream(senders.filter(s => s.track).map(s => s.track));
            localVideo.classList.remove('hidden');
            showVideoContainer();
        } else {
            localVideo.srcObject = null;
            localVideo.classList.add('hidden');
        }
    });

    if (session.connection) {
        console.log('[DEBUG] connection already exists, set listeners');
        setConnectionListeners(session.connection);
    } else {
        console.log('[DEBUG] no connection yet. waiting event peerconnection');
        session.on('peerconnection', (data) => {
            const pc = data.peerconnection;
            console.log('[DEBUG] session event "peerconnection"', { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, signalingState: pc.signalingState });
            setConnectionListeners(pc);

        });
    }

    session.on('failed', (e) => {
        console.log('[DEBUG] session event "failed"', { cause: e.cause });
        stopAudio();
        if (session.direction === 'outgoing') {
            playAudio({ audio: busyAudio, repeat: 3 });
        }
        cleanupCall();
    });

    session.on('ended', (e) => {
        console.log('[DEBUG] session event "ended"');
        stopAudio();
        if (e.originator === 'remote' || e.originator === 'system') {
            playAudio({ audio: busyAudio, repeat: 3 });
        }
        cleanupCall();
    });
}

function setConnectionListeners(pc) {
    pc.addEventListener('track', (event) => {
        const track = event.track;

        if (track.kind === 'audio') {
            console.log('[DEBUG] audio "track" event', { readyState: track.readyState, enabled: track.enabled });
            const remoteAudio = document.getElementById('remote-audio');
            if (!remoteAudio.srcObject)
                remoteAudio.srcObject = new MediaStream();
            const stream = remoteAudio.srcObject;
            stream.getAudioTracks().forEach(oldTrack => stream.removeTrack(oldTrack));
            stream.addTrack(track);

            track.addEventListener('mute', () => {
                console.log('[DEBUG] audio track "mute" event', { readyState: track.readyState, enabled: track.enabled });
            });

            track.addEventListener('unmute', () => {
                console.log('[DEBUG] audio track "unmute" event', { readyState: track.readyState, enabled: track.enabled });
            });

            track.addEventListener('ended', () => {
                console.log('[DEBUG] audio track "ended" event', { readyState: track.readyState, enabled: track.enabled });
                stream.removeTrack(track);
                remoteAudio.srcObject = null;
            });
        }

        if (track.kind === 'video') {
            console.log('[DEBUG] video "track" event', { readyState: track.readyState, enabled: track.enabled });

            const remoteVideo = document.getElementById('remote-video');
            if (!remoteVideo.srcObject)
                remoteVideo.srcObject = new MediaStream();
            const stream = remoteVideo.srcObject;
            stream.getVideoTracks().forEach(oldTrack => stream.removeTrack(oldTrack));
            stream.addTrack(track);

            showRemoteVideoContainer();

            track.addEventListener('mute', () => {
                console.log('[DEBUG] video track "mute" event', { readyState: track.readyState, enabled: track.enabled });
                document.getElementById('remote-video').classList.add('video-paused');
            });

            track.addEventListener('unmute', () => {
                console.log('[DEBUG] video track "unmute" event', { readyState: track.readyState, enabled: track.enabled });
                document.getElementById('remote-video').classList.remove('video-paused');
            });

            track.addEventListener('ended', () => {
                console.log('[DEBUG] video track "ended" event', { readyState: track.readyState, enabled: track.enabled });
                hideRemoteVideoContainer();
            });
        }
    });
}

function endCall() {
    if (currentSession) {
        currentSession.terminate(); // 'ended' event will call cleanupCall()
    } else {
        cleanupCall();
    }
}


function cleanupCall() {
    currentSession = null;
    clearCallTimer();
    setDialerVisible(true);
    document.getElementById('phone-input').value = '';
    document.getElementById('video-container').style.display = 'none';
    document.getElementById('incoming-modal').style.display = 'none';
    setCallButtonState(false);

    document.getElementById('remote-video').srcObject = null;
    const localVideo = document.getElementById('local-video');
    localVideo.srcObject = null;
    localVideo.classList.add('hidden');
    // isSendingVideo remains unchanged to preserve the last selected mode for the next call

    isMuted = false;
    const muteBtn = document.getElementById('mute-toggle');
    if (muteBtn) {
        muteBtn.textContent = 'Mute';
        muteBtn.classList.remove('btn-muted');
    }

    hideRemoteVideoContainer();

    if (ua && ua.isRegistered()) {
        updateStatus('Online / Registered', '#2ecc71');
    } else {
        updateStatus('Online', '#475569');
    }
    stopCamera();
}

function updateStatus(text, color) {
    const statusText = document.getElementById('status-text');
    statusText.innerText = text;
    statusText.style.color = color || '#475569';
}

function changeScreen(screenName) {
    const phoneApp = document.getElementById('phone-app');

    if (phoneApp.classList.contains('view-settings') && screenName === 'phone') {
        saveSettings();
        initJsSIP();
    }

    phoneApp.className = `view-${screenName}`;

    if (screenName === 'phone') {
        setTimeout(() => {
            document.getElementById('phone-input').focus();
        }, 50);
    }
}

function toggleSettings() {
    const phoneApp = document.getElementById('phone-app');
    if (phoneApp.classList.contains('view-settings')) {
        changeScreen('phone');
    } else {
        changeScreen('settings');
    }
}

function togglePasswordVisibility() {
    const passwordInput = document.getElementById('setting-password');
    passwordInput.type = (passwordInput.type === 'password') ? 'text' : 'password';
}

function saveSettings() {
    const settings = {
        server: document.getElementById('setting-server').value,
        ice: document.getElementById('setting-ice').value,
        displayname: document.getElementById('setting-displayname').value,
        username: document.getElementById('setting-username').value,
        password: document.getElementById('setting-password').value
    };
    localStorage.setItem('rtc_settings', JSON.stringify(settings));
}

function loadSettings() {
    const saved = localStorage.getItem('rtc_settings');
    if (saved) {
        try {
            const settings = JSON.parse(saved);
            document.getElementById('setting-server').value = settings.server || '';
            document.getElementById('setting-ice').value = settings.ice || '';
            document.getElementById('setting-displayname').value = settings.displayname || '';
            document.getElementById('setting-username').value = settings.username || '';
            document.getElementById('setting-password').value = settings.password || '';
        } catch (e) {
            console.error('Error parsing settings from localStorage', e);
        }
    }
}


function isWebRtcAvailable() {
    return navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
}


async function checkMediaDevices() {
    const response = { camera: false, microphone: false, speaker: false };
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices.forEach((device) => {
        switch (device.kind) {
            case 'videoinput':
                response.camera = true;
                break;
            case 'audioinput':
                response.microphone = true;
                break;
            case 'audiooutput':
                response.speaker = true;
                break;
        }
    });
    if (!navigator.webkitGetUserMedia)
        response.speaker = true;
    return response;
}


function stopCamera() {
    if (localMediaStream) {
        localMediaStream.getTracks().forEach(track => track.stop());
        localMediaStream = null;
    }
}


function playAudio({ audio, volume = 1.0, mute = false, loop = false, repeat = 1 }) {
    console.log(`[DEBUG] playAudio ${audio.src.split('/').pop()}`);
    stopAudio();
    currentAudio = audio;
    currentAudio.volume = volume;
    currentAudio.muted = mute;
    let currentPlayCount = 1;
    if (loop) {
        currentAudio.loop = true;
    } else {
        currentAudio.loop = false;
        currentAudio.onended = () => {
            if (currentPlayCount < repeat) {
                currentPlayCount++;
                currentAudio.currentTime = 0;
                currentPlayPromise = currentAudio.play().catch(() => { });
            } else {
                currentAudio.onended = null;
            }
        };
    }

    currentAudio.currentTime = 0;
    currentPlayPromise = currentAudio.play();
    return currentPlayPromise
        .then(() => true)
        .catch(err => {
            if (err.name !== 'AbortError') {
                console.warn('Audio play blocked or failed:', err);
            }
            return false;
        });
}


function stopAudio() {
    console.log('[DEBUG] stopAudio');
    if (currentAudio) {
        const audioToPause = currentAudio;
        audioToPause.onended = null;

        if (currentPlayPromise) {
            currentPlayPromise
                .finally(() => {
                    audioToPause.pause();
                    audioToPause.currentTime = 0;
                });
        } else {
            try {
                audioToPause.pause();
                audioToPause.currentTime = 0;
            } catch (e) {
                console.error('Error pausing audio', e);
            }
        }

        if (currentAudio === audioToPause) {
            currentAudio.loop = false;
            currentAudio = null;
            currentPlayPromise = null;
        }
    }
}


// Global unlock function linked to the HTML banner button
function unlockAudio() {
    // Single test run to satisfy browser rules
    console.log('[DEBUG] unlockAudio');
    playAudio({ audio: ringingAudio, loop: false, repeat: 1 }).then(success => {
        if (success) {
            stopAudio();
            document.getElementById('audio-unlock-banner').style.display = 'none';
        }
    });
}
