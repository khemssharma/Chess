import { Chess, Color, PieceSymbol, Square } from "chess.js";
import { useState } from "react";
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
    validMoves?: Array<{from: string, to: string, promotion?: string}>;
    onSquareClick?: (square: string) => void;
    playerColor?: "white" | "black";
    disabled?: boolean;
}) => {
    const [from, setFrom] = useState<null | Square>(null);
    const [showPromotion, setShowPromotion] = useState(false);
    const [promotionMove, setPromotionMove] = useState<{from: Square, to: Square} | null>(null);

    // Helper function to check if a piece belongs to the current player
    const isPlayerPiece = (square: Square) => {
        const piece = chess.get(square);
        if (!piece) return false;
        const pieceColor = piece.color === 'w' ? 'white' : 'black';
        return pieceColor === playerColor;
    };

    // Helper function to check if a move is a pawn promotion
    const isPawnPromotion = (from: Square, to: Square) => {
        const piece = chess.get(from);
        if (!piece || piece.type !== 'p') return false;
        
        const toRank = parseInt(to[1]);
        return (piece.color === 'w' && toRank === 8) || (piece.color === 'b' && toRank === 1);
    };

    // Handle promotion piece selection
    const handlePromotion = (piece: 'q' | 'r' | 'b' | 'n') => {
        if (!promotionMove) return;

        // Send move to server with promotion
        socket.send(JSON.stringify({
            type: MOVE,
            payload: {
                move: {
                    from: promotionMove.from,
                    to: promotionMove.to,
                    promotion: piece
                }
            }
        }));

        // Make move locally
        try {
            chess.move({
                from: promotionMove.from,
                to: promotionMove.to,
                promotion: piece
            });
            setBoard(chess.board());
        } catch (e) {
            console.log("Invalid promotion move");
        }

        // Reset states
        setShowPromotion(false);
        setPromotionMove(null);
        setFrom(null);
    };

    // Check if a square is a valid move destination
    const isValidMove = (square: string) => {
        if (!validMoves || validMoves.length === 0) return false;
        return validMoves.some(move => move.to === square);
    };

    // Check if a square is the selected "from" square
    const isSelectedSquare = (square: string) => {
        return from === square;
    };

    // Flip board if player is black
    const displayBoard = playerColor === "black" ? [...board].reverse().map(row => [...row].reverse()) : board;

    return <div className="text-white-200 w-full">
        <div className="w-full aspect-square max-w-md mx-auto">
        {displayBoard.map((row, i) => {
            return <div key={i} className="flex">
                {row.map((square, j) => {
                    // Calculate the actual square coordinates considering board flip
                    const file = playerColor === "black" ? 7 - (j % 8) : (j % 8);
                    const rank = playerColor === "black" ? i + 1 : 8 - i;
                    const squareRepresentation = String.fromCharCode(97 + file) + "" + rank as Square;
                    const isLightSquare = (i + j) % 2 === 0;
                    const isValid = isValidMove(squareRepresentation);
                    const isSelected = isSelectedSquare(squareRepresentation);

                    // Determine square color
                    let bgColor = isLightSquare ? 'bg-green-500' : 'bg-slate-500';
                    if (isSelected) {
                        bgColor = isLightSquare ? 'bg-yellow-400' : 'bg-yellow-600';
                    }

                    return <div 
                        onClick={() => {
                            if (disabled) return; // Prevent interaction when disabled
                            
                            if (!from) {
                                // Only allow selecting pieces that belong to the current player
                                if (!isPlayerPiece(squareRepresentation)) {
                                    return;
                                }
                                setFrom(squareRepresentation);
                                // Request valid moves when selecting a piece
                                if (onSquareClick) {
                                    onSquareClick(squareRepresentation);
                                }
                            } else {
                                // Only make move if it's valid or if we're clicking the same square to deselect
                                if (squareRepresentation === from) {
                                    // Deselect the piece
                                    setFrom(null);
                                    if (onSquareClick) {
                                        onSquareClick(''); // Clear valid moves
                                    }
                                    return;
                                }

                                // Check if this is a pawn promotion
                                if (isPawnPromotion(from, squareRepresentation)) {
                                    setPromotionMove({ from, to: squareRepresentation });
                                    setShowPromotion(true);
                                    return;
                                }

                                // Send move to server (server will validate)
                                socket.send(JSON.stringify({
                                    type: MOVE,
                                    payload: {
                                        move: {
                                            from,
                                            to: squareRepresentation
                                        }
                                    }
                                }))
                                
                                // Try to make the move locally
                                try {
                                    chess.move({
                                        from,
                                        to: squareRepresentation
                                    });
                                    setBoard(chess.board());
                                } catch (e) {
                                    // If move is invalid, the server will reject it
                                    console.log("Invalid move attempted");
                                }
                                
                                setFrom(null);
                                console.log({
                                    from,
                                    to: squareRepresentation
                                })
                            }
                        }} 
                        key={j} 
                        className={`w-full aspect-square ${bgColor} relative ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                        <div className="w-full justify-center flex h-full">
                            <div className="h-full justify-center flex flex-col">
                                {square ? <img className="w-1/2 md:w-3/5" src={`/${square?.color === "b" ? square?.type : `${square?.type?.toUpperCase()} copy`}.png`} /> : null}
                            </div>
                        </div>
                        
                        {/* Valid move indicator */}
                        {isValid && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                {square ? (
                                    // If there's a piece on this square (capture), show a ring
                                    <div className="w-4/5 aspect-square border-2 md:border-3 border-red-500 rounded-full opacity-60"></div>
                                ) : (
                                    // If empty square, show a dot
                                    <div className="w-1/5 aspect-square bg-gray-800 rounded-full opacity-60"></div>
                                )}
                            </div>
                        )}
                    </div>
                })}
            </div>
        })}
        </div>
        
        {/* Promotion Dialog */}
        {showPromotion && (
            <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
                <div className="bg-white p-4 md:p-6 rounded-lg shadow-2xl mx-4">
                    <h3 className="text-black text-lg md:text-xl font-bold mb-3 md:mb-4 text-center">Choose Promotion</h3>
                    <div className="flex gap-2 md:gap-4">
                        <button 
                            onClick={() => handlePromotion('q')}
                            className="w-14 h-14 md:w-20 md:h-20 bg-green-500 hover:bg-green-600 rounded-lg flex items-center justify-center border-2 md:border-4 border-green-700 transition-all hover:scale-110"
                        >
                            <img src={`/${playerColor === "white" ? "Q copy" : "q"}.png`} alt="Queen" className="w-10 md:w-14" />
                        </button>
                        <button 
                            onClick={() => handlePromotion('r')}
                            className="w-14 h-14 md:w-20 md:h-20 bg-blue-500 hover:bg-blue-600 rounded-lg flex items-center justify-center border-2 md:border-4 border-blue-700 transition-all hover:scale-110"
                        >
                            <img src={`/${playerColor === "white" ? "R copy" : "r"}.png`} alt="Rook" className="w-10 md:w-14" />
                        </button>
                        <button 
                            onClick={() => handlePromotion('b')}
                            className="w-14 h-14 md:w-20 md:h-20 bg-purple-500 hover:bg-purple-600 rounded-lg flex items-center justify-center border-2 md:border-4 border-purple-700 transition-all hover:scale-110"
                        >
                            <img src={`/${playerColor === "white" ? "B copy" : "b"}.png`} alt="Bishop" className="w-10 md:w-14" />
                        </button>
                        <button 
                            onClick={() => handlePromotion('n')}
                            className="w-14 h-14 md:w-20 md:h-20 bg-orange-500 hover:bg-orange-600 rounded-lg flex items-center justify-center border-2 md:border-4 border-orange-700 transition-all hover:scale-110"
                        >
                            <img src={`/${playerColor === "white" ? "N copy" : "n"}.png`} alt="Knight" className="w-10 md:w-14" />
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
}