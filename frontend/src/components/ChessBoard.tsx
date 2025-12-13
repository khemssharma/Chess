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
    playerColor = "white"
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
}) => {
    const [from, setFrom] = useState<null | Square>(null);

    // Helper function to check if a piece belongs to the current player
    const isPlayerPiece = (square: Square) => {
        const piece = chess.get(square);
        if (!piece) return false;
        const pieceColor = piece.color === 'w' ? 'white' : 'black';
        return pieceColor === playerColor;
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

    return <div className="text-white-200">
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
                        className={`w-16 h-16 ${bgColor} relative cursor-pointer`}
                    >
                        <div className="w-full justify-center flex h-full">
                            <div className="h-full justify-center flex flex-col">
                                {square ? <img className="w-4" src={`/${square?.color === "b" ? square?.type : `${square?.type?.toUpperCase()} copy`}.png`} /> : null}
                            </div>
                        </div>
                        
                        {/* Valid move indicator */}
                        {isValid && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                {square ? (
                                    // If there's a piece on this square (capture), show a ring
                                    <div className="w-14 h-14 border-4 border-red-500 rounded-full opacity-60"></div>
                                ) : (
                                    // If empty square, show a dot
                                    <div className="w-4 h-4 bg-gray-800 rounded-full opacity-60"></div>
                                )}
                            </div>
                        )}
                    </div>
                })}
            </div>
        })}
    </div>
}