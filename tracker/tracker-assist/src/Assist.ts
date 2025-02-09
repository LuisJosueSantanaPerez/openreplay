import type { Socket } from 'socket.io-client';
import io from 'socket.io-client';
import Peer from 'peerjs';
import type { Properties } from 'csstype';
import { App } from '@openreplay/tracker';

import RequestLocalStream from './LocalStream.js';
import Mouse from './Mouse.js';
import CallWindow from './CallWindow.js';
import ConfirmWindow, { callConfirmDefault, controlConfirmDefault } from './ConfirmWindow.js';
import type { Options as ConfirmOptions } from './ConfirmWindow.js';


//@ts-ignore  peerjs hack for webpack5 (?!) TODO: ES/node modules;
Peer = Peer.default || Peer;

type BehinEndCallback = () => ((()=>{}) | void)

export interface Options {
  onAgentConnect: BehinEndCallback,
  onCallStart: BehinEndCallback,
  onRemoteControlStart: BehinEndCallback,
  session_calling_peer_key: string,
  session_control_peer_key: string,
  callConfirm: ConfirmOptions,
  controlConfirm: ConfirmOptions,

  confirmText?: string, // @depricated
  confirmStyle?: Properties, // @depricated

  config: RTCConfiguration,
}


enum CallingState {
  Requesting,
  True,
  False,
};


type Agent = {
  onDisconnect: ((()=>{}) | void), // TODO: better types here
  name?: string
  //
}

export default class Assist {
  readonly version = "PACKAGE_VERSION"

  private socket: Socket | null = null
  private peer: Peer | null = null
  private assistDemandedRestart: boolean = false
  private callingState: CallingState = CallingState.False

  private agents: Record<string, Agent> = {}
  private readonly options: Options
  constructor(
    private readonly app: App, 
    options?: Partial<Options>, 
    private readonly noSecureMode: boolean = false,
  ) {
    this.options = Object.assign({ 
        session_calling_peer_key: "__openreplay_calling_peer",
        session_control_peer_key: "__openreplay_control_peer",
        config: null,
        onCallStart: ()=>{},
        onAgentConnect: ()=>{},
        onRemoteControlStart: ()=>{},
        callConfirm: {},
        controlConfirm: {}, // TODO: clear options passing/merging/overriting
      },
      options,
    );

    if (document.hidden !== undefined) {
      const sendActivityState = () => this.emit("UPDATE_SESSION", { active: !document.hidden })
      app.attachEventListener(
        document,
        'visibilitychange',
        sendActivityState,
        false,
        false,
      )
    }
    const titleNode = document.querySelector('title')
    const observer = titleNode && new MutationObserver(() => {
      this.emit("UPDATE_SESSION", { pageTitle: document.title })
    })
    app.attachStartCallback(() => { 
      if (this.assistDemandedRestart) { return; }
      this.onStart()
      observer && observer.observe(titleNode, { subtree: true, characterData: true, childList: true })
    })
    app.attachStopCallback(() => { 
      if (this.assistDemandedRestart) { return; } 
      this.clean()
      observer && observer.disconnect()
    })
    app.attachCommitCallback((messages) => {
      if (this.agentsConnected) {
        // @ts-ignore No need in statistics messages. TODO proper filter
        if (messages.length === 2 && messages[0]._id === 0 &&  messages[1]._id === 49) { return }
        this.emit("messages", messages)
      }
    })
    app.session.attachUpdateCallback(sessInfo => this.emit("UPDATE_SESSION", sessInfo))
  }

  private emit(ev: string, ...args) {
    this.socket && this.socket.emit(ev, ...args)
  }

  private get agentsConnected(): boolean {
    return Object.keys(this.agents).length > 0
  }

  private notifyCallEnd() {
    this.emit("call_end");
  }
  private onRemoteCallEnd = () => {}

  private onStart() {
    const app = this.app
    const peerID = `${app.getProjectKey()}-${app.getSessionID()}`

    // SocketIO
    const socket = this.socket = io(app.getHost(), {
      path: '/ws-assist/socket',
      query: {
        "peerId": peerID,
        "identity": "session",
        "sessionInfo": JSON.stringify({ 
          pageTitle: document.title, 
          ...this.app.getSessionInfo() 
        }),
      },
      transports: ["websocket"],
    })
    socket.onAny((...args) => app.debug.log("Socket:", ...args))

    socket.on("NEW_AGENT", (id: string, info) => {
      this.agents[id] = {
        onDisconnect: this.options.onAgentConnect && this.options.onAgentConnect(),
        ...info, // TODO
      }
      this.assistDemandedRestart = true
      this.app.stop();
      this.app.start().then(() => { this.assistDemandedRestart = false })
    })
    socket.on("AGENTS_CONNECTED", (ids) => {
      ids.forEach(id =>{
        this.agents[id] = {
          onDisconnect: this.options.onAgentConnect && this.options.onAgentConnect(),
        }
      })
      this.assistDemandedRestart = true
      this.app.stop();
      this.app.start().then(() => { this.assistDemandedRestart = false })
      const storedControllingAgent = sessionStorage.getItem(this.options.session_control_peer_key)
      if (storedControllingAgent !== null && ids.includes(storedControllingAgent)) {
        grantControl(storedControllingAgent)
        socket.emit("control_granted", storedControllingAgent)
      } else {
        sessionStorage.removeItem(this.options.session_control_peer_key)
      }
    })

    let confirmRC: ConfirmWindow | null = null
    const mouse = new Mouse()     // TODO: lazy init
    let controllingAgent: string | null = null
    const requestControl = (id: string) => {
      if (controllingAgent !== null) { 
        socket.emit("control_rejected", id)
        return
      }
      controllingAgent = id // TODO: more explicit pending state
      confirmRC = new ConfirmWindow(controlConfirmDefault(this.options.controlConfirm))
      confirmRC.mount().then(allowed => {
        if (allowed) {
          grantControl(id)
          socket.emit("control_granted", id)
        } else {
          releaseControl()
          socket.emit("control_rejected", id)
        }
      }).catch()
    }
    let onRemoteControlStop: (()=>void) | null = null
    const grantControl = (id: string) => {
      controllingAgent = id
      mouse.mount()
      onRemoteControlStop = this.options.onRemoteControlStart() || null
      sessionStorage.setItem(this.options.session_control_peer_key, id)
    }
    const releaseControl = () => {
      typeof onRemoteControlStop === 'function' && onRemoteControlStop()
      onRemoteControlStop = null
      confirmRC?.remove()
      mouse.remove()
      controllingAgent = null
      sessionStorage.removeItem(this.options.session_control_peer_key)
    }
    socket.on("request_control", requestControl)
    socket.on("release_control", (id: string) => {
      if (controllingAgent !== id) { return }
      releaseControl()
    })


    socket.on("scroll", (id, d) => { id === controllingAgent && mouse.scroll(d) })
    socket.on("click", (id, xy) => { id === controllingAgent && mouse.click(xy) })
    socket.on("move", (id, xy) => { id === controllingAgent && mouse.move(xy) })

    let confirmCall:ConfirmWindow | null = null

    socket.on("AGENT_DISCONNECTED", (id) => {
      // @ts-ignore (wtf, typescript?!)
      this.agents[id] && this.agents[id].onDisconnect != null && this.agents[id].onDisconnect()
      delete this.agents[id]

      controllingAgent === id && releaseControl()

      // close the call also
      if (callingAgent === id) {
        confirmCall?.remove()
        this.onRemoteCallEnd()
      }
    })
    socket.on("NO_AGENT", () => {
      this.agents = {}
    })
    socket.on("call_end", () => this.onRemoteCallEnd()) // TODO: check if agent calling id

    // TODO: fix the code
    let agentName = ""
    let callingAgent = ""
    socket.on("_agent_name",(id, name) => { agentName = name; callingAgent = id })


    // PeerJS call (todo: use native WebRTC)
    const peerOptions = {
      host: app.getHost(),
      path: '/assist',
      port: location.protocol === 'http:' && this.noSecureMode ? 80 : 443,
      //debug: appOptions.__debug_log ? 2 : 0, // 0 Print nothing //1 Prints only errors. / 2 Prints errors and warnings. / 3 Prints all logs.
    }
    if (this.options.config) {
      peerOptions['config'] = this.options.config
    }
    const peer = this.peer = new Peer(peerID, peerOptions);
    app.debug.log('Peer created: ', peer)
    peer.on('error', e => app.debug.warn("Peer error: ", e.type, e))
    peer.on('disconnect', () => peer.reconnect())
    peer.on('call', (call) => {
      app.debug.log("Call: ", call)    
      if (this.callingState !== CallingState.False) {
        call.close()
        //this.notifyCallEnd() // TODO: strictly connect calling peer with agent socket.id
        app.debug.warn("Call closed instantly bacause line is busy. CallingState: ", this.callingState)
        return;
      }

      const setCallingState = (newState: CallingState) => {
        if (newState === CallingState.True) {
          sessionStorage.setItem(this.options.session_calling_peer_key, call.peer);
        } else if (newState === CallingState.False) {
          sessionStorage.removeItem(this.options.session_calling_peer_key);
        }
        this.callingState = newState;
      }
      
      let confirmAnswer: Promise<boolean>
      const callingPeer = sessionStorage.getItem(this.options.session_calling_peer_key)
      if (callingPeer === call.peer) {
        confirmAnswer = Promise.resolve(true)
      } else {
        setCallingState(CallingState.Requesting)
        confirmCall = new ConfirmWindow(callConfirmDefault(this.options.callConfirm || { 
          text: this.options.confirmText,
          style: this.options.confirmStyle,
        }))
        confirmAnswer = confirmCall.mount()
        this.onRemoteCallEnd = () => { // if call cancelled by a caller before confirmation
          app.debug.log("Received call_end during confirm window opened")
          confirmCall?.remove()
          setCallingState(CallingState.False)
        }
      }

      confirmAnswer.then(agreed => {
        if (!agreed) {
          call.close()
          this.notifyCallEnd()
          setCallingState(CallingState.False)
          return
        }

        let callUI = new CallWindow()
        callUI.setAssistentName(agentName)
        
        const onCallEnd = this.options.onCallStart()
        const handleCallEnd = () => {
          call.close()
          callUI.remove()
          setCallingState(CallingState.False)
          onCallEnd && onCallEnd()
        }
        const initiateCallEnd = () => {
          this.notifyCallEnd()
          handleCallEnd()
        }
        this.onRemoteCallEnd = handleCallEnd

        call.on('error', e => {
          app.debug.warn("Call error:", e)
          initiateCallEnd()
        });

        RequestLocalStream().then(lStream => {
          call.on('stream', function(rStream) {
            callUI.setRemoteStream(rStream);
            const onInteraction = () => { // only if hidden?
              callUI.playRemote()
              document.removeEventListener("click", onInteraction)
            }
            document.addEventListener("click", onInteraction)
          });

          lStream.onVideoTrack(vTrack => {
            const sender = call.peerConnection.getSenders().find(s => s.track?.kind === "video")
            if (!sender) {
              app.debug.warn("No video sender found")
              return
            }
            app.debug.log("sender found:", sender)
            sender.replaceTrack(vTrack)
          })

          callUI.setCallEndAction(initiateCallEnd)
          callUI.setLocalStream(lStream)
          call.answer(lStream.stream)
          setCallingState(CallingState.True)
        })
        .catch(e => {
          app.debug.warn("Audio mediadevice request error:", e)
          initiateCallEnd()
        });
      }).catch(); // in case of Confirm.remove() without any confirmation/decline
    });
  }

  private clean() {
    if (this.peer) {
      this.peer.destroy()
      this.app.debug.log("Peer destroyed")
    }
    if (this.socket) {
      this.socket.disconnect()
      this.app.debug.log("Socket disconnected")
    }
  }
}