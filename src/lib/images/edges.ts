/**
 * Photo sizes shared by the browser and the server (no server code here).
 * A photo of one card is kept up to 2000 px on its long side, which is more
 * than the reader needs. A photo of several cards is kept up to 4000 px:
 * each card is only a part of it, and the small print of a card (the
 * copyright line, the corner number) is read from that part.
 */
export const PHOTO_EDGE = 2000;
export const MANY_CARDS_EDGE = 4000;
