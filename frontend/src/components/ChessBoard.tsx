import { Chess, Color, PieceSymbol, Square } from "chess.js";
import { useState, useRef } from "react";
import { MOVE } from "../screens/Game";

export const ChessBoard = ({
    chess,
    board,
    socket,
    setBoard,
    validMoves,
    onSquareClick,
    playerColor = "white",
    disabled = false
}: {
    chess: Chess;
    setBoard: React.Dispatch<React.SetStateAction<({
        square: Square;
        type: PieceSymbol;
        color: Color;
    } | null)[][]>>;
    board: ({
        square: Square;
        type: PieceSymbol;
        color: Color;
    } | null)[][];
    socket: WebSocket;
    validMoves?: Array<{ from: string; to: string; promotion?: string }>;
    onSquareClick?: (square: string) => void;
    playerColor?: "white" | "black";
    disabled?: boolean;
}) => {
    const [from, setFrom] = useState<null | Square>(null);
    const [showPromotion, setShowPromotion] = useState(false);
    const [promotionMove, setPromotionMove] = useState<{ from: Square; to: Square } | null>(null);

    // Drag state
    const [dragFrom, setDragFrom] = useState<Square | null>(null);
    const [dragOver, setDragOver] = useState<Square | null>(null);
    const boardRef = useRef<HTMLDivElement>(null);

    // ── Helpers ──────────────────────────────────────────────────────────────

    const isPlayerPiece = (square: Square) => {
        const piece = chess.get(square);
        if (!piece) return false;
        return (piece.color === "w" ? "white" : "black") === playerColor;
    };

    const isPawnPromotion = (from: Square, to: Square) => {
        const piece = chess.get(from);
        if (!piece || piece.type !== "p") return false;
        const toRank = parseInt(to[1]);
        return (piece.color === "w" && toRank === 8) || (piece.color === "b" && toRank === 1);
    };

    const isValidMove = (square: string) => {
        if (!validMoves || validMoves.length === 0) return false;
        return validMoves.some((m) => m.to === square);
    };

    // ── Shared move execution ─────────────────────────────────────────────────

    const executeMove = (fromSq: Square, toSq: Square, promotion?: "q" | "r" | "b" | "n") => {
        socket.send(JSON.stringify({
            type: MOVE,
            payload: { move: { from: fromSq, to: toSq, ...(promotion ? { promotion } : {}) } }
        }));
        try {
            chess.move({ from: fromSq, to: toSq, ...(promotion ? { promotion } : {}) });
            setBoard(chess.board());
        } catch {
            console.log("Invalid move attempted");
        }
    };

    const handlePromotion = (piece: "q" | "r" | "b" | "n") => {
        if (!promotionMove) return;
        executeMove(promotionMove.from, promotionMove.to, piece);
        setShowPromotion(false);
        setPromotionMove(null);
        setFrom(null);
    };

    // ── Click handlers ────────────────────────────────────────────────────────

    const handleSquareClick = (squareRepresentation: Square) => {
        if (disabled) return;

        if (!from) {
            if (!isPlayerPiece(squareRepresentation)) return;
            setFrom(squareRepresentation);
            onSquareClick?.(squareRepresentation);
        } else {
            if (squareRepresentation === from) {
                setFrom(null);
                onSquareClick?.("");
                return;
            }

            if (isPawnPromotion(from, squareRepresentation)) {
                setPromotionMove({ from, to: squareRepresentation });
                setShowPromotion(true);
                return;
            }

            executeMove(from, squareRepresentation);
            setFrom(null);
        }
    };

    // ── Drag handlers ─────────────────────────────────────────────────────────

    const handleDragStart = (e: React.DragEvent, square: Square) => {
        if (disabled || !isPlayerPiece(square)) {
            e.preventDefault();
            return;
        }
        setDragFrom(square);
        setFrom(square);
        onSquareClick?.(square);

        // Use a transparent 1x1 pixel as the default drag ghost (we show our own)
        const ghost = document.createElement("img");
        ghost.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        e.dataTransfer.setDragImage(ghost, 0, 0);
        e.dataTransfer.effectAllowed = "move";
    };

    const handleDragOver = (e: React.DragEvent, square: Square) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(square);
    };

    const handleDragLeave = () => {
        setDragOver(null);
    };

    const handleDrop = (e: React.DragEvent, toSq: Square) => {
        e.preventDefault();
        setDragOver(null);

        if (!dragFrom || toSq === dragFrom) {
            setDragFrom(null);
            return;
        }

        if (isPawnPromotion(dragFrom, toSq)) {
            setPromotionMove({ from: dragFrom, to: toSq });
            setShowPromotion(true);
            setDragFrom(null);
            setFrom(null);
            return;
        }

        executeMove(dragFrom, toSq);
        setDragFrom(null);
        setFrom(null);
        onSquareClick?.("");
    };

    const handleDragEnd = () => {
        setDragFrom(null);
        setDragOver(null);
    };

    // ── Board rendering ───────────────────────────────────────────────────────

    const displayBoard = playerColor === "black"
        ? [...board].reverse().map((row) => [...row].reverse())
        : board;

    return (
        <div className="text-white-200 w-full relative">
            <div ref={boardRef} className="w-full aspect-square max-w-md mx-auto select-none">
                {displayBoard.map((row, i) => (
                    <div key={i} className="flex">
                        {row.map((square, j) => {
                            const file = playerColor === "black" ? 7 - (j % 8) : j % 8;
                            const rank = playerColor === "black" ? i + 1 : 8 - i;
                            const squareRepresentation = (String.fromCharCode(97 + file) + rank) as Square;

                            const isLightSquare = (i + j) % 2 === 0;
                            const isSelected = from === squareRepresentation;
                            const isDragSource = dragFrom === squareRepresentation;
                            const isDragTarget = dragOver === squareRepresentation;
                            const isValid = isValidMove(squareRepresentation);

                            let bgColor = isLightSquare ? "bg-green-500" : "bg-slate-500";
                            if (isSelected || isDragSource) {
                                bgColor = isLightSquare ? "bg-yellow-400" : "bg-yellow-600";
                            }
                            if (isDragTarget && isValid) {
                                bgColor = isLightSquare ? "bg-blue-300" : "bg-blue-500";
                            }

                            const piece = square;
                            const canDrag = !disabled && piece && isPlayerPiece(squareRepresentation);

                            return (
                                <div
                                    key={j}
                                    className={`w-full aspect-square ${bgColor} relative ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
                                    onClick={() => handleSquareClick(squareRepresentation)}
                                    onDragOver={(e) => handleDragOver(e, squareRepresentation)}
                                    onDragLeave={handleDragLeave}
                                    onDrop={(e) => handleDrop(e, squareRepresentation)}
                                >
                                    <div className="w-full justify-center flex h-full">
                                        <div className="h-full justify-center flex flex-col">
                                            {piece && (
                                                <img
                                                    draggable={!!canDrag}
                                                    onDragStart={(e) => handleDragStart(e, squareRepresentation)}
                                                    onDragEnd={handleDragEnd}
                                                    className={`w-1/2 md:w-3/5 transition-opacity duration-75 ${isDragSource ? "opacity-30" : "opacity-100"} ${canDrag ? "cursor-grab active:cursor-grabbing" : ""}`}
                                                    src={`/${piece.color === "b" ? piece.type : `${piece.type.toUpperCase()} copy`}.png`}
                                                    alt={`${piece.color}${piece.type}`}
                                                />
                                            )}
                                        </div>
                                    </div>

                                    {/* Valid move indicator */}
                                    {isValid && (
                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                            {piece ? (
                                                <div className="w-4/5 aspect-square border-2 md:border-3 border-red-500 rounded-full opacity-60" />
                                            ) : (
                                                <div className="w-1/5 aspect-square bg-gray-800 rounded-full opacity-60" />
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>

            {/* Promotion Dialog */}
            {showPromotion && (
                <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
                    <div className="bg-white p-4 md:p-6 rounded-lg shadow-2xl mx-4">
                        <h3 className="text-black text-lg md:text-xl font-bold mb-3 md:mb-4 text-center">Choose Promotion</h3>
                        <div className="flex gap-2 md:gap-4">
                            {(["q", "r", "b", "n"] as const).map((piece, idx) => {
                                const colors = ["bg-green-500 hover:bg-green-600 border-green-700", "bg-blue-500 hover:bg-blue-600 border-blue-700", "bg-purple-500 hover:bg-purple-600 border-purple-700", "bg-orange-500 hover:bg-orange-600 border-orange-700"];
                                const labels = ["Queen", "Rook", "Bishop", "Knight"];
                                const imgName = playerColor === "white" ? `${piece.toUpperCase()} copy` : piece;
                                return (
                                    <button
                                        key={piece}
                                        onClick={() => handlePromotion(piece)}
                                        className={`w-14 h-14 md:w-20 md:h-20 ${colors[idx]} rounded-lg flex items-center justify-center border-2 md:border-4 transition-all hover:scale-110`}
                                    >
                                        <img src={`/${imgName}.png`} alt={labels[idx]} className="w-10 md:w-14" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
