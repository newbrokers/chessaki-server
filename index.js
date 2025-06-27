"use client"

import type React from "react"

/* ------------------------------------------------------------------ *\
CHESS – connecting peer-to-peer using WebRTC with WebSocket signaling and fallback
\* ------------------------------------------------------------------ */

import { useState, useEffect, useRef, useCallback } from "react"
import { Chess } from "chess.js"
import { useSound } from "@/components/sound-provider" // Import the useSound hook
import { useWebRTCGame } from "./connection-hooks"
import { cloneWithHistory } from "@/utils/chess-utils" // Import cloneWithHistory function
import { startFreshGame } from "@/utils/game-utils" // Import startFreshGame function

// Add import for useRouter
import { useRouter } from "next/navigation"

/* ---------- ✱ NEW – time-control presets ------------------------- */
const TIME_CONTROLS = {
  // Classical
  c90: { label: "Classical 90 + 30", base: 90 * 60 * 1000, inc: 30 * 1000 },
  c60: { label: "Classical 60 + 0", base: 60 * 60 * 1000, inc: 0 },
  c30: { label: "Classical 30 + 20", base: 30 * 60 * 1000, inc: 20 * 1000 },

  // Rapid
  r25: { label: "Rapid 25 + 10", base: 25 * 60 * 1000, inc: 10 * 1000 },
  r15: { label: "Rapid 15 + 10", base: 15 * 60 * 1000, inc: 10 * 1000 },
  r10: { label: "Rapid 10 + 0", base: 10 * 60 * 1000, inc: 0 },
  r10i: { label: "Rapid 10 + 5", base: 10 * 60 * 1000, inc: 5 * 1000 },

  // Blitz
  b05: { label: "Blitz 5 + 3", base: 5 * 60 * 1000, inc: 3 * 1000 },
  b03: { label: "Blitz 3 + 2", base: 3 * 60 * 1000, inc: 2 * 1000 },
  b05z: { label: "Blitz 5 + 0", base: 5 * 60 * 1000, inc: 0 },
  b03z: { label: "Blitz 3 + 0", base: 3 * 60 * 1000, inc: 0 },

  // Bullet
  bu2: { label: "Bullet 2 + 1", base: 2 * 60 * 1000, inc: 1 * 1000 },
  bu1i: { label: "Bullet 1 + 1", base: 1 * 60 * 1000, inc: 1 * 1000 },
  bu1: { label: "Bullet 1 + 0", base: 1 * 60 * 1000, inc: 0 },
  bu30: { label: "Bullet 30 + 0", base: 30 * 1000, inc: 0 },

  // UltraBullet
  ub20: { label: "Ultrabullet 20 + 0", base: 20 * 1000, inc: 0 },
  ub15: { label: "Ultrabullet 15 + 0", base: 15 * 1000, inc: 0 },
} as const
type TCId = keyof typeof TIME_CONTROLS
/* ------------------------------------------------------------------ */

type Status = "waiting" | "countdown" | "playing" | "checkmate" | "draw" | "stalemate"

type Msg =
  | { type: "move"; uci: string; spent: number; fen: string; whiteMs: number; blackMs: number; status: string }
  | { type: "resign" }
  | { type: "rematch-offer" }
  | { type: "rematch-accept" }
  | { type: "draw-offer" }
  | { type: "draw-accept" }
  | { type: "game_end"; winner: "white" | "black" | null; isDraw: boolean; message: string }
  | { type: "timer_sync"; whiteMs: number; blackMs: number; status: string; gameNo: number; fen: string }
  | { type: "sync_request" }
  | { type: "heartbeat"; whiteMs: number; blackMs: number }
  | { type: "connection_status"; creatorConnected: boolean; joinerConnected: boolean }
  | { type: "game_created"; playerPin: string; viewerPin: string; isCreator: boolean; creatorName: string }
  | { type: "opponent-joined"; joinerName: string }
  | { type: "viewer-joined"; creatorName: string; joinerName: string; viewerCount: number }
  | {
      type: "game_start"
      settings: { timeControl: TCId; totalGames: number; countdown: number }
      creatorName: string
      joinerName: string
      timestamp: number
    }
  | { type: "error"; message: string }

/* ---------- helpers ---------- */
function randomPin() {
  const letters = Array(2)
    .fill(0)
    .map(() => String.fromCharCode(65 + Math.floor(Math.random() * 26)))
    .join("")
  const digits = String(Math.floor(100 + Math.random() * 900))
  return letters + digits
}

/* ----------------------------- */

export default function QuickGamePage() {
  // Get WebRTC game functions with error handling
  const webRTCData = useWebRTCGame()

  const {
    isCreator,
    pin,
    playerPin,
    viewerPin,
    creatorName,
    joinerName,
    connReady,
    openConnection,
    connectAsViewer,
    pushMove,
    pushRematchOffer,
    push,
    registerMessageCallback,
    connectionInfo,
    isViewer,
    viewerCount,
    viewerWaiting,
    closeConnection,
    setConnReady,
  } = webRTCData

  // Inside QuickGamePage component, add the router instance
  const router = useRouter()

  const [game, setGame] = useState(new Chess())
  const gameRef = useRef<Chess>(game)
  const [status, setStatus] = useState<Status>("waiting")
  const [locallyDisconnected, setLocallyDisconnected] = useState(false)

  const [pendingPin, setPendingPin] = useState("")
  const [viewerPinInput, setViewerPinInput] = useState("")
  const [playerName, setPlayerName] = useState("") // For online mode
  const [boardSize, setBoardSize] = useState(360) // Default to 10% smaller for mobile (was 400)
  const [clickedSquare, setClickedSquare] = useState<string | null>(null)

  // Keep gameRef in sync with game state
  useEffect(() => {
    gameRef.current = game
  }, [game])

  // Reset local disconnection flag when a fresh connection is established
  useEffect(() => {
    if (connReady) {
      setLocallyDisconnected(false)
      // Reset opponent heartbeat timer when we reconnect
      lastOpponentHeartbeat.current = Date.now()
      setOpponentConnected(true)
    }
  }, [connReady])

  const [resigned, setResigned] = useState(false)
  const [gameNo, setGameNo] = useState(1) // 1st, 2nd, 3rd … game of the session

  const [selectedColor, setSelectedColor] = useState<"white" | "black">("white") // For online mode
  const [alternateRematches, setAlternateRematches] = useState(true) // Changed default to true
  const [timeCtrl, setTimeCtrl] = useState<TCId>("b05") /* ✱ */

  const { playSound, isMuted } = useSound() // Get playSound from the context

  // NEW: State for premoves and their highlights
  const [premoves, setPremove] = useState<string[]>([])
  const [premoveHighlights, setPremoveHighlights] = useState<Record<string, { background: string }>>({})
  const [dragVec, setDragVec] = useState<[number, number]>([0, 0])

  /* ---- clocks ---------------------------------------------------- */
  const [whiteMs, setWhiteMs] = useState(TIME_CONTROLS[timeCtrl].base)
  const [blackMs, setBlackMs] = useState(TIME_CONTROLS[timeCtrl].base)
  const turnStart = useRef<number | null>(null)
  const tickId = useRef<ReturnType<typeof setInterval> | null>(null)
  const lowTimeWarningPlayed = useRef({ white: false, black: false }) // To prevent spamming low time warning

  const [countDown, setCountDown] = useState(0) // in ms, e.g. 10000

  // ---- ONLINE-ONLY state ----
  const [showOnlineOptions, setShowOnlineOptions] = useState(false)
  const [showModeSelection, setShowModeSelection] = useState(true)
  const [gameStarted, setGameStarted] = useState(false)
  const [isCreatorWaiting, setIsCreatorWaiting] = useState(false)
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  // ----------------------------------------------------------------------
  // Add a new state variable at the top of the `QuickGamePage` component, alongside other `useState` declarations:
  const [lastMoveSquares, setLastMoveSquares] = useState<{ from: string; to: string } | null>(null)
  const [onlineModeType, setOnlineModeType] = useState<"invite" | "invitee" | null>(null)
  const [totalGamesInput, setTotalGamesInput] = useState<string>("1")
  const actualTotalGames = totalGamesInput === "" ? 1 : Number(totalGamesInput)

  // Helper function to get current effective total games for display
  const getCurrentTotalGames = () => {
    if (isCreator) {
      // Creator uses their own total games setting (extended automatically in startFreshGame)
      return actualTotalGames
    } else {
      // Joiner uses the opponent's total games setting (extended automatically in startFreshGame)
      return opponentTotalGames
    }
  }
  const [opponentTotalGames, setOpponentTotalGames] = useState<number>(1) // For the joiner to receive
  const [countdownDuration, setCountdownDuration] = useState(5)

  // Add new state and ref at the top of the component, alongside other `useState` and `useRef` declarations:
  const [tempMouseDownSquare, setTempMouseDownSquare] = useState<string | null>(null)
  const [gameEndMessage, setGameEndMessage] = useState<string | null>(null)
  const boardContainerRef = useRef<HTMLDivElement>(null)

  // NEW: State for scores and who resigned
  const [player1Score, setPlayer1Score] = useState(0)
  const [player2Score, setPlayer2Score] = useState(0)
  const [resignedBy, setResignedBy] = useState<"white" | "black" | null>(null)

  // State for persistent player labels (survive disconnect/reconnect)
  const [creatorLabel, setCreatorLabel] = useState<string>("Player 1")
  const [joinerLabel, setJoinerLabel] = useState<string>("Player 2")
  const [rematchPending, setRematchPending] = useState(false)

  // State for rematch offer modal
  const [rematchOfferReceived, setRematchOfferReceived] = useState(false)
  const [rematchOfferedBy, setRematchOfferedBy] = useState<string>("")
  const [rematchOfferSent, setRematchOfferSent] = useState(false)

  // State for draw offer modal
  const [drawOfferReceived, setDrawOfferReceived] = useState(false)
  const [drawOfferedBy, setDrawOfferedBy] = useState<string>("")
  const [drawOfferSent, setDrawOfferSent] = useState(false)

  // State for post-resignation rematch modal
  const [showPostResignationModal, setShowPostResignationModal] = useState(false)

  // State for disconnect confirmation modal
  const [showDisconnectModal, setShowDisconnectModal] = useState(false)

  // State for opponent connection status
  const [opponentConnected, setOpponentConnected] = useState<boolean | null>(null) // null = unknown (gray), true = connected (green), false = disconnected (red)
  const lastOpponentHeartbeat = useRef<number>(Date.now())

  // State for viewer connection status (received from creator)
  const [viewerConnectionStatus, setViewerConnectionStatus] = useState({
    creatorConnected: true,
    joinerConnected: true,
  })

  // State for viewer board orientation
  const [viewerBoardOrientation, setViewerBoardOrientation] = useState<"white" | "black">("white")

  // State for copy button feedback
  const [playerPinCopied, setPlayerPinCopied] = useState(false)
  const [viewerPinCopied, setViewerPinCopied] = useState(false)
  const [pgnCopied, setPgnCopied] = useState(false)

  // State to track if we just requested a sync (to avoid processing our own response)
  const [justRequestedSync, setJustRequestedSync] = useState(false)

  // Helper function for copy with feedback
  const handleCopyWithFeedback = useCallback(
    (text: string, setFeedback: (value: boolean) => void) => {
      navigator.clipboard.writeText(text)
      playSound("button_click")
      setFeedback(true)
      setTimeout(() => setFeedback(false), 3000) // Reset after 3 seconds
    },
    [playSound],
  )

  // Helper function to build proper PGN with custom headers
  const buildPGN = useCallback(
    (game: Chess, gameNumber: number) => {
      const today = new Date()
      const year = today.getFullYear()
      const month = String(today.getMonth() + 1).padStart(2, "0")
      const day = String(today.getDate()).padStart(2, "0")

      const tags = [
        `[Event "Game ${gameNumber}"]`,
        `[Site "chessaki.com"]`,
        `[Date "${year}.${month}.${day}"]`,
        `[Round "${gameNumber}"]`,
        `[White "${creatorLabel || "Player 1"}"]`,
        `[Black "${joinerLabel || "Player 2"}"]`,
        "", // blank line before moves
      ]

      // Format moves as "1. e4 e5 5. Nf3 Nc6 ..."
      const history = game.history()
      const moveText = []
      for (let i = 0; i < history.length; i += 2) {
        const moveNumber = Math.floor(i / 2) + 1
        const whiteMove = history[i]
        const blackMove = history[i + 1] || "—"
        if (blackMove) {
          moveText.push(`${moveNumber}. ${whiteMove} ${blackMove}`)
        } else {
          moveText.push(`${moveNumber}. ${whiteMove}`)
        }
      }

      return tags.join("\n") + "\n" + moveText.join(" ")
    },
    [creatorLabel, joinerLabel],
  )

  /** decide what colour the CREATOR has in the *current* game */
  // Changed to a function declaration for hoisting
  function colourOfCreator(): "white" | "black" {
    if (!alternateRematches) return selectedColor
    // flip every new game
    return gameNo % 2 === 1 ? selectedColor : selectedColor === "white" ? "black" : "white"
  }

  /* Board orientation for online games only */
  const myBoardOrientation = isViewer
    ? viewerBoardOrientation
    : isCreator
      ? colourOfCreator()
      : colourOfCreator() === "white"
        ? "black"
        : "white"

  // Derived player names for scoring (consistent across rematches)
  // Use persistent labels that survive disconnect/reconnect cycles
  const player1NameForScore = creatorLabel
  const player2NameForScore = joinerLabel

  // Update persistent labels whenever hook provides names
  useEffect(() => {
    if (creatorName) setCreatorLabel(creatorName)
    if (joinerName) setJoinerLabel(joinerName)
  }, [creatorName, joinerName])

  // Send timer sync to new viewers when they join
  const lastViewerCount = useRef(viewerCount)

  useEffect(() => {
    if (
      !isViewer &&
      connReady &&
      status === "playing" &&
      isCreator &&
      viewerCount > lastViewerCount.current // viewer(s) just joined
    ) {
      console.log("Sending one-off timer sync to new viewer(s)")
      push({
        type: "timer_sync",
        whiteMs,
        blackMs,
        status,
        gameNo,
        fen: game.fen(),
      })
    }
    lastViewerCount.current = viewerCount
  }, [viewerCount, isViewer, connReady, status, isCreator, whiteMs, blackMs, push, gameNo, game])

  // Heartbeat system - send heartbeat every 7 seconds to opponent
  useEffect(() => {
    if (!connReady || isViewer) return

    const sendHeartbeat = () => {
      console.log("Sending heartbeat to opponent with timers")
      // NEW: Send current clock values with heartbeat
      push({
        type: "heartbeat",
        whiteMs: whiteMs,
        blackMs: blackMs,
      })
    }

    // Send initial heartbeat immediately
    sendHeartbeat()

    // Set up interval to send heartbeat every 7 seconds
    const heartbeatInterval = setInterval(sendHeartbeat, 7000)

    return () => clearInterval(heartbeatInterval)
  }, [connReady, isViewer, push, whiteMs, blackMs]) // Add whiteMs and blackMs

  // Check opponent heartbeat - mark as disconnected if no heartbeat for 25 seconds
  useEffect(() => {
    if (!connReady || isViewer) return

    const checkOpponentHeartbeat = () => {
      const now = Date.now()
      const timeSinceLastHeartbeat = now - lastOpponentHeartbeat.current

      if (timeSinceLastHeartbeat > 13000) {
        // 13 seconds
        console.log(`Opponent heartbeat timeout: ${timeSinceLastHeartbeat}ms since last heartbeat`)
        setOpponentConnected(false)
      }
    }

    // Check every 5 seconds
    const checkInterval = setInterval(checkOpponentHeartbeat, 5000)

    return () => clearInterval(checkInterval)
  }, [connReady, isViewer])

  // Creator broadcasts connection status to viewers every 30 seconds
  useEffect(() => {
    if (!connReady || isViewer || !isCreator) return

    const sendConnectionStatus = () => {
      push({
        type: "connection_status",
        creatorConnected: connReady,
        joinerConnected: opponentConnected === null ? false : opponentConnected, // treat null as disconnected for viewers
      })
    }

    // Send initial status immediately
    sendConnectionStatus()

    // Set up interval to send connection status every 30 seconds
    const statusInterval = setInterval(sendConnectionStatus, 30000)

    return () => clearInterval(statusInterval)
  }, [connReady, isViewer, isCreator, opponentConnected, push])

  // Send sync request when reconnecting
  useEffect(() => {
    if (connReady && !isViewer && status !== "waiting") {
      setJustRequestedSync(true)
      push({ type: "sync_request" }) // 👈 new handshake request
    }
  }, [connReady]) // one-shot per reconnection

  // Creator polling logic
  useEffect(() => {
    if (!isCreator || !playerPin || !isCreatorWaiting) {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
      return
    }

    console.log(`Creator is waiting. Starting to poll game status for PIN: ${playerPin}`)

    const poll = async () => {
      try {
        const serverBaseUrl = process.env.NEXT_PUBLIC_WEBSOCKET_SERVER
          ? process.env.NEXT_PUBLIC_WEBSOCKET_SERVER.replace(/^wss?:\/\//, "https://") // Convert ws/wss to http/https
          : "http://localhost:8080" // Fallback for local dev

        const response = await fetch(`${serverBaseUrl}/api/game-status/${playerPin}`)
        if (!response.ok) {
          console.error("Polling failed:", response.statusText)
          if (response.status === 404) {
            setIsCreatorWaiting(false)
          }
          return
        }
        const data = await response.json()
        console.log("Polling response:", data)

        if (data.gameReady) {
          console.log("Joiner has connected! Creator is now connecting to WebSocket...")
          setIsCreatorWaiting(false) // This will stop the polling via the effect's dependency check

          // Creator connects to the WebSocket to start the game.
          openConnection(playerPin, creatorName, true)
        }
      } catch (error) {
        console.error("Error during polling:", error)
      }
    }

    pollingIntervalRef.current = setInterval(poll, 3000)
    poll() // Poll immediately

    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
  }, [isCreator, playerPin, isCreatorWaiting, openConnection, creatorName])

  /* countdown effect */
  useEffect(() => {
    if (status !== "countdown") return
    if (countDown <= 0) {
      setStatus("playing")
      playSound("game_start")

      /* Only start White's clock for truly new games, not reconnections */
      /* For reconnections, the clock should already be running for the correct player */
      if (game.history().length === 0) {
        // New game - everyone starts White's clock; Black's will start after the first move
        console.log("New game countdown finished - starting White's clock")
        startClock("w")
      } else {
        // Reconnection scenario - don't reset clocks, just continue for current turn
        console.log("Reconnection countdown finished - continuing clock for current player:", game.turn())
        startClock(game.turn()) // Continue clock for whoever's turn it actually is
      }

      return
    }
    const id = setInterval(() => {
      setCountDown((ms) => ms - 1000)
      playSound("timer_tick", 0.3) // Play a subtle tick sound during countdown
    }, 1000)
    return () => clearInterval(id)
  }, [status, countDown, isCreator, selectedColor, playSound, game])

  const startClock = (colour: "w" | "b") => {
    stopClock()
    turnStart.current = Date.now()
    console.log(`Starting ${colour === "w" ? "White" : "Black"}'s clock`)
    tickId.current = setInterval(() => {
      const now = Date.now()
      const spent = now - (turnStart.current ?? now)
      if (colour === "w") setWhiteMs((ms) => Math.max(ms - spent, 0))
      else setBlackMs((ms) => Math.max(ms - spent, 0))
      turnStart.current = now
    }, 100)
  }
  const stopClock = () => {
    if (tickId.current) clearInterval(tickId.current)
    tickId.current = null
    turnStart.current = null
  }

  // Helper to get player name by color (for scoring)
  const getPlayerNameByColor = useCallback(
    (color: "white" | "black") => {
      const creatorColorThisGame = colourOfCreator()
      return color === creatorColorThisGame ? creatorName : joinerName
    },
    [creatorName, joinerName],
  )

  // Helper function to cleanly disconnect
  function hardDisconnect(sendLeave = false) {
    /* 🆕 Stop local timers to prevent stale mutations */
    stopClock()

    /* 1️⃣  Close whatever the hook gives us */
    if (closeConnection) {
      closeConnection()
    }

    /* 2️⃣  If the hook didn't expose a setter, keep our own flag */
    if (!setConnReady) {
      setLocallyDisconnected(true) // local React state
    } else {
      setConnReady(false) // will update provider + UI
    }

    /* 3️⃣  Tell the signalling server we're done (optional but nice) */
    if (sendLeave) {
      push({ type: "leave" }) // broadcast exactly once
    }
  }

  // Shared resignation helper
  function finishResign(
    winningColour: "white" | "black",
    local: boolean, // ← new flag: did *I* click resign?
  ) {
    stopClock()
    setResigned(true)
    setStatus("checkmate")

    /* banner text */
    const winnerTxt = winningColour === "white" ? "White" : "Black"
    const banner = local
      ? `You resigned. ${winnerTxt} wins!`
      : `${winnerTxt === "White" ? "Black" : "White"} resigned. ${winnerTxt} wins!`

    setGameEndMessage(banner)

    /* score */
    // Determine who gets the point based on who won
    const creatorColorThisGame = colourOfCreator()
    const creatorWon = winningColour === creatorColorThisGame

    console.log(
      "finishResign - winningColour:",
      winningColour,
      "creatorColorThisGame:",
      creatorColorThisGame,
      "creatorWon:",
      creatorWon,
      "isCreator:",
      isCreator,
    )

    if (creatorWon) {
      // Creator won - creator is always player1NameForScore
      console.log("Awarding point to creator (player1)")
      setPlayer1Score((p) => p + 1)
    } else {
      // Joiner won - joiner is always player2NameForScore
      console.log("Awarding point to joiner (player2)")
      setPlayer2Score((p) => p + 1)
    }

    playSound("resign")

    /* Show rematch modal after a brief delay */
    setTimeout(() => {
      setShowPostResignationModal(true)
    }, 2000) // 2 second delay to let players read the resignation message
  }

  const updateStatus = (g: Chess, moverColour: "w" | "b" | null = null) => {
    let message: string | null = null
    let winner: "white" | "black" | null = null
    let isDraw = false

    if (g.isCheckmate()) {
      setStatus("checkmate")
      stopClock()
      playSound("checkmate")
      winner = g.turn() === "w" ? "black" : "white" // The player who just moved won
      message = `${winner === "white" ? "White" : "Black"} Won by Checkmate!`
    } else if (g.isStalemate()) {
      setStatus("stalemate")
      stopClock()
      playSound("stalemate")
      isDraw = true
      message = "Stalemate!"
    } else if (g.isDraw()) {
      setStatus("draw")
      stopClock()
      playSound("draw")
      isDraw = true
      message = "Draw!"
    } else if (whiteMs <= 0) {
      // Check for timeout *before* setting to playing
      setStatus("checkmate") // Treat timeout as a loss (checkmate status)
      stopClock()
      playSound("time_out")

      // Handle timeout as resignation locally
      const winningColour = "black" // White timed out, Black wins
      finishResign(winningColour, true) // Handle locally like a resignation

      // Notify opponent about timeout (auto-resignation)
      if (connReady) {
        push({ type: "resign" })
        console.log("White timed out - sending auto-resign to opponent")
      }
      return // Exit early to prevent double score update
    } else if (blackMs <= 0) {
      // Check for timeout *before* setting to playing
      setStatus("checkmate") // Treat timeout as a loss (checkmate status)
      stopClock()
      playSound("time_out")

      // Handle timeout as resignation locally
      const winningColour = "white" // Black timed out, White wins
      finishResign(winningColour, true) // Handle locally like a resignation

      // Notify opponent about timeout (auto-resignation)
      if (connReady) {
        push({ type: "resign" })
        console.log("Black timed out - sending auto-resign to opponent")
      }
      return // Exit early to prevent double score update
    } else {
      setStatus("playing")
      startClock(moverColour === "w" ? "b" : "w") // other side to move
      if (g.isCheck()) {
        playSound("check") // Play check sound
      }
    }

    // Update scores and message if game ended
    if (message) {
      setGameEndMessage(message)
      if (isDraw) {
        setPlayer1Score((prev) => prev + 0.5)
        setPlayer2Score((prev) => prev + 0.5)
      } else if (winner) {
        // Determine who gets the point based on who won
        const creatorColorThisGame = colourOfCreator()
        const creatorWon = winner === creatorColorThisGame

        console.log(
          "updateStatus - winner:",
          winner,
          "creatorColorThisGame:",
          creatorColorThisGame,
          "creatorWon:",
          creatorWon,
        )

        if (creatorWon) {
          // Creator won - creator is always player1NameForScore
          console.log("Awarding point to creator (player1)")
          setPlayer1Score((prev) => prev + 1)
        } else {
          // Joiner won - joiner is always player2NameForScore
          console.log("Awarding point to joiner (player2)")
          setPlayer2Score((prev) => prev + 1)
        }
      }

      // Note: No game_end message needed for natural endings (checkmate, stalemate, draw by rules)
      // Both players detect these when processing the same final move
      // game_end messages are only used for manual endings (resignation, timeout, draw offers)

      /* Show rematch modal after a brief delay for natural game endings */
      setTimeout(() => {
        setShowPostResignationModal(true)
      }, 2000)
    }
  }

  // Add these new callback functions after the `updateStatus` function:
  const handleBoardMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!boardContainerRef.current) return

      const rect = boardContainerRef.current.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top

      const squareSize = boardSize / 8

      let fileIndex = Math.floor(x / squareSize)
      let rankIndex = Math.floor(y / squareSize)

      // Adjust for board orientation
      if (myBoardOrientation === "black") {
        fileIndex = 7 - fileIndex
        rankIndex = 7 - rankIndex
      }

      const file = String.fromCharCode(97 + fileIndex)
      const rank = 8 - rankIndex // Ranks are 8 at top, 1 at bottom

      setTempMouseDownSquare(`${file}${rank}`)
    },
    [boardSize, myBoardOrientation], // Added myBoardOrientation to dependencies
  )

  const handleBoardMouseUp = useCallback(() => {
    setTempMouseDownSquare(null)
  }, [])

  /* called by react-chessboard while dragging */
  const onDragMove = useCallback((piece: string, sourceSq: string, targetSq: string, pixDelta: [number, number]) => {
    setDragVec(pixDelta) // save latest Δx, Δy
  }, [])

  /* ---------- apply a move that came from peer ---------- */
  const applyRemoteMove = (uci: string, timeSpent: number) => {
    const g = cloneWithHistory(gameRef.current) // <-- preserve history

    try {
      const moverColour = g.turn() // before move
      const move = g.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] as any,
      })
      if (!move) throw new Error("illegal")

      // Sounds
      if (move.captured) playSound("capture")
      else if (move.san.includes("O-O")) playSound("castle")
      else playSound("move")

      setLastMoveSquares({ from: move.from, to: move.to })

      // subtract spent time from that colour & add increment
      const inc = TIME_CONTROLS[timeCtrl].inc
      if (moverColour === "w") setWhiteMs((ms) => ms - timeSpent + inc)
      else setBlackMs((ms) => Math.max(ms - timeSpent + inc, 0))

      // --- NEW: Apply pre-moves ---
      const finalBoard = g // Start with the board after opponent's move
      let appliedPremoveCount = 0

      // Clear premoves and highlights before attempting to apply them,
      // as they will be re-evaluated based on the new board state.
      // This also handles the case where no premoves are valid.
      setPremoveHighlights({})
      setPremove([])

      for (const premoveUci of premoves) {
        const premoveFrom = premoveUci.slice(0, 2)
        const premoveTo = premoveUci.slice(2, 4)
        const premovePromotion = premoveUci[4] as any

        const appliedPremove = finalBoard.move({ from: premoveFrom, to: premoveTo, promotion: premovePromotion })

        if (appliedPremove) {
          // Premove was valid and applied
          appliedPremoveCount++
          // Play sound for the executed premove
          if (appliedPremove.captured) {
            playSound("capture")
          } else if (appliedPremove.san.includes("O-O")) {
            playSound("castle")
          } else {
            playSound("move")
          }
          // Continue to next premove in queue
        } else {
          // Premove is invalid, cancel all remaining premoves
          playSound("premove_cancel")
          break // Exit loop, no more premoves will be applied
        }
      }

      // Commit final board state once at the end
      setGame(finalBoard)

      // Update status based on final board state
      if (appliedPremoveCount > 0) {
        updateStatus(finalBoard, moverColour === "w" ? "b" : "w") // Update status based on the last move's turn
      } else {
        updateStatus(finalBoard, moverColour) // Use original mover colour
      }

      // Ensure premoves and highlights are cleared after processing
      setPremove([])
      setPremoveHighlights({})
    } catch (error) {
      console.warn("[sync] rejected duplicated or out-of-order move", uci, error)
      return // simply ignore duplicates
    }
  }

  // Message handler functions - moved to component level to be accessible by registerMessageCallback
  const handleMove = useCallback((data: { uci: string; spent: number }) => {
    applyRemoteMove(data.uci, data.spent)
  }, []) // No dependencies needed since applyRemoteMove uses refs

  const handleResign = useCallback(() => {
    if (status !== "playing") return
    if (resigned) return // already processed - safeguard against double clicks
    push({ type: "resign" }) // notify peer
    const winner = myBoardOrientation === "white" ? "black" : "white"
    finishResign(winner, true) // ← local = true
  }, [status, resigned, push, myBoardOrientation])

  const handleRemoteResign = useCallback(() => {
    if (resigned) return // ignore duplicates
    console.log("Opponent resigned (could be manual resignation or timeout)")
    finishResign(myBoardOrientation, false) // ← your colour is the winner
  }, [resigned, myBoardOrientation])

  const handleRematchOffer = useCallback(
    (fromPlayer?: string) => {
      // Receiving a rematch offer - show modal for accept/decline
      if (fromPlayer) {
        console.log(`Received rematch offer from ${fromPlayer}`)
        setRematchOfferedBy(fromPlayer)
        setRematchOfferReceived(true)
        playSound("button_click") // Play notification sound
      } else {
        // This player is making a rematch offer
        if (status !== "playing" && status !== "countdown") {
          startFreshGame() // countdown will start when game_start arrives
        }
      }
    },
    [status, startFreshGame, playSound],
  )

  const handleRematchAccept = useCallback(() => {
    if (status !== "playing" && status !== "countdown") {
      // Both players are already connected - just start fresh game
      console.log("Accepting rematch - both players already connected")
      startFreshGame()
    }
  }, [status, startFreshGame])

  // Function to accept rematch offer
  const acceptRematchOffer = useCallback(() => {
    console.log("Accepting rematch offer")
    setRematchOfferReceived(false)
    setRematchOfferedBy("")

    // Send rematch accept message to opponent
    push({ type: "rematch-accept" })

    // Start fresh game locally
    startFreshGame()
    playSound("button_click")
  }, [push, startFreshGame, playSound])

  // Function to decline rematch offer
  const declineRematchOffer = useCallback(() => {
    console.log("Declining rematch offer")
    setRematchOfferReceived(false)
    setRematchOfferedBy("")

    // Could send a decline message if needed in the future
    // push({ type: "rematch-decline" });

    playSound("button_click")
  }, [playSound])

  // Function to offer draw
  const offerDraw = useCallback(() => {
    if (status !== "playing") return // Only allow during active games
    if (drawOfferSent) return // Prevent multiple offers

    console.log("Offering draw to opponent")
    setDrawOfferSent(true)

    // Send draw offer message to opponent
    push({ type: "draw-offer" })
    playSound("button_click")
  }, [status, drawOfferSent, push, playSound])

  // Function to accept draw offer
  const acceptDrawOffer = useCallback(() => {
    console.log("Accepting draw offer")
    setDrawOfferReceived(false)
    setDrawOfferedBy("")
    setDrawOfferSent(false)

    // Send draw accept message to opponent
    push({ type: "draw-accept" })

    // End the game as draw locally
    setStatus("draw")
    stopClock()
    playSound("draw")

    const message = "Draw by Agreement!"
    setGameEndMessage(message)

    // Both players get 0.5 points
    setPlayer1Score((prev) => prev + 0.5)
    setPlayer2Score((prev) => prev + 0.5)

    /* Show rematch modal after a brief delay for draw by agreement */
    setTimeout(() => {
      setShowPostResignationModal(true)
    }, 2000)
  }, [push, playSound])

  // Function to decline draw offer
  const declineDrawOffer = useCallback(() => {
    console.log("Declining draw offer")
    setDrawOfferReceived(false)
    setDrawOfferedBy("")
    playSound("button_click")
  }, [playSound])

  // Function to handle receiving draw offer
  const handleDrawOffer = useCallback(
    (fromPlayer: string) => {
      console.log(`Received draw offer from ${fromPlayer}`)
      setDrawOfferedBy(fromPlayer)
      setDrawOfferReceived(true)
      playSound("notification")
    },
    [playSound],
  )

  // Function to handle draw accept
  const handleDrawAccept = useCallback(() => {
    console.log("Draw offer accepted by opponent")
    setDrawOfferSent(false)

    // End the game as draw locally
    setStatus("draw")
    stopClock()
    playSound("draw")

    const message = "Draw by Agreement!"
    setGameEndMessage(message)

    // Both players get 0.5 points
    setPlayer1Score((prev) => prev + 0.5)
    setPlayer2Score((prev) => prev + 0.5)

    /* Show rematch modal after a brief delay for draw by agreement */
    setTimeout(() => {
      setShowPostResignationModal(true)
    }, 2000)
  }, [playSound])

  // Function to handle post-resignation rematch offer
  const handlePostResignationRematch = useCallback(() => {
    console.log("Offering rematch after resignation")
    setShowPostResignationModal(false)

    // Use the existing rematch system
    if (connReady && status !== "playing" && status !== "countdown") {
      console.log("Sending rematch offer to opponent")
      pushRematchOffer()
      setRematchOfferSent(true)
      playSound("button_click")
    }
  }, [connReady, status, pushRematchOffer, playSound])

  // Function to decline post-resignation rematch
  const handlePostResignationDecline = useCallback(() => {
    console.log("Declining rematch after resignation")
    setShowPostResignationModal(false)
    // Players stay connected but no rematch
  }, [])

  // Register message callbacks
  useEffect(() => {
    registerMessageCallback("move", handleMove)
    registerMessageCallback("resign", handleRemoteResign)
    registerMessageCallback("rematch-offer", handleRematchOffer)
    registerMessageCallback("rematch-accept", handleRematchAccept)
    registerMessageCallback("draw-offer", handleDrawOffer)
    registerMessageCallback("draw-accept", handleDrawAccept)
    registerMessageCallback(
      "game_end",
      (data: { winner: "white" | "black" | null; isDraw: boolean; message: string }) => {
        setStatus("game_end")
        setGameEndMessage(data.message)
        if (data.winner === "white") {
          setPlayer1Score((prev) => prev + 1)
        } else if (data.winner === "black") {
          setPlayer2Score((prev) => prev + 1)
        }
      },
    )
    registerMessageCallback(
      "timer_sync",
      (data: { whiteMs: number; blackMs: number; status: string; gameNo: number; fen: string }) => {
        setWhiteMs(data.whiteMs)
        setBlackMs(data.blackMs)
        setStatus(data.status as Status)
        setGameNo(data.gameNo)
        setGame(new Chess(data.fen))
      },
    )
    registerMessageCallback("heartbeat", (data: { whiteMs: number; blackMs: number }) => {
      lastOpponentHeartbeat.current = Date.now()
      setOpponentConnected(true)
    })
    registerMessageCallback("connection_status", (data: { creatorConnected: boolean; joinerConnected: boolean }) => {
      setViewerConnectionStatus(data)
    })
    registerMessageCallback(
      "game_created",
      (data: { playerPin: string; viewerPin: string; isCreator: boolean; creatorName: string }) => {
        if (data.isCreator) {
          webRTCData.setPlayerPin(data.playerPin)
          webRTCData.setViewerPin(data.viewerPin)
          setCreatorName(data.creatorName)
        } else {
          setJoinerName(data.creatorName)
        }
      },
    )
    registerMessageCallback("opponent-joined", (data: { joinerName: string }) => {
      setJoinerName(data.joinerName)
    })
    registerMessageCallback(
      "viewer-joined",
      (data: { creatorName: string; joinerName: string; viewerCount: number }) => {
        setCreatorName(data.creatorName)
        setJoinerName(data.joinerName)
        webRTCData.setViewerCount(data.viewerCount)
      },
    )
    registerMessageCallback(
      "game_start",
      (data: {
        settings: { timeControl: TCId; totalGames: number; countdown: number }
        creatorName: string
        joinerName: string
        timestamp: number
      }) => {
        setCreatorName(data.creatorName)
        setJoinerName(data.joinerName)
        setTimeCtrl(data.settings.timeControl)
        setCountDown(data.settings.countdown * 1000)
        setGame(new Chess())
        setStatus("countdown")
      },
    )
    registerMessageCallback("error", (data: { message: string }) => {
      console.error("Error received:", data.message)
    })
  }, [
    registerMessageCallback,
    handleMove,
    handleRemoteResign,
    handleRematchOffer,
    handleRematchAccept,
    handleDrawOffer,
    handleDrawAccept,
    webRTCData,
  ])

  return <div>{/* Game UI components here */}</div>
}
