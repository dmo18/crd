import { describe, expect, it } from "vitest";
import type { OcrLine, OcrResult } from "./ocr";
import { parseCardText } from "./parse";

/**
 * The reading rules of 12R.4, one principle at a time, on text laid out as
 * the reader returns it (boxes as fractions of the card). Each rule is about
 * how cards are printed, never about one card.
 */

/** [text, y, x, w, h] */
type Row = [string, number, number?, number?, number?];

function side(rows: Row[]): OcrResult {
  const lines: OcrLine[] = rows.map(([text, y, x = 0.1, w = 0.6, h = 0.03]) => ({ text, confidence: 0.95, box: { x, y, w, h } }));
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: 0.9 };
}
const parse = (front: Row[] | null, back: Row[] | null) => parseCardText(front ? side(front) : null, back ? side(back) : null);

describe("player name", () => {
  it("takes the largest name-like text on the front", () => {
    const p = parse([["ORIOLES • PITCHER", 0.89, 0.3, 0.4, 0.03], ["BOB MILACKI", 0.82, 0.24, 0.5, 0.07]], null);
    expect(p.player).toBe("Bob Milacki");
  });

  it("never takes a section heading, a set title or a stat header as the name", () => {
    expect(parse([["HALL OF FAME", 0.06, 0.15, 0.7, 0.1]], null).player).toBeNull();
    expect(parse([["HALLOF FAME", 0.06, 0.15, 0.7, 0.1], ["BILLY MILLS", 0.86, 0.27, 0.5, 0.04]], null).player).toBe("Billy Mills");
    const back: Row[] = [
      ["RECENT MAJOR LEAGUE PERFORMANCE", 0.05, 0.1, 0.8, 0.06],
      ["CAREER HIGHLIGHTS", 0.12, 0.1, 0.5, 0.05],
      ["YEAR TEAM ERA G IP H R ER BB SO", 0.2, 0.1, 0.8, 0.03],
      ["round secondary phase", 0.25, 0.6, 0.3, 0.03],
    ];
    expect(parse(null, back).player).toBeNull();
  });

  it("never takes a name from running text on the back", () => {
    const back: Row[] = [
      ["During the 1964 Tokyo Olympic Games he became the", 0.47, 0.07, 0.85],
      ["president of Billy Mills Enterprises.", 0.63, 0.06, 0.5],
    ];
    expect(parse(null, back).player).toBeNull();
  });

  it("uses the back only as a heading at the top", () => {
    expect(parse(null, [["JOE CARTER", 0.05, 0.2, 0.5, 0.05], ["Bats: Right Throws: Right", 0.15]]).player).toBe("Joe Carter");
    // The same name low on the back, in normal type, is not a heading.
    expect(parse(null, [["Bats: Right", 0.1], ["JOE CARTER", 0.6, 0.2, 0.5, 0.03], ["Throws: Right", 0.7]]).player).toBeNull();
  });

  it("keeps the front's form when the back gives the full name, and counts a shared surname as agreement", () => {
    const mills = parse([["BILLY MILLS", 0.86, 0.27, 0.5, 0.04]], [["WILLIAM MERVIN MILLS", 0.05, 0.07, 0.77, 0.06], ["Athletics", 0.2, 0.43, 0.13, 0.03]]);
    expect(mills.player).toBe("Billy Mills");
    expect(mills.playerAgree).toBe(true);
    expect(mills.playerCandidates).toEqual(["Billy Mills", "William Mervin Mills"]);
    // A name printed in two lines at the top of the back is one name.
    const milacki = parse([["BOB MILACKI", 0.82, 0.24, 0.5, 0.07]], [["ROBERT", 0.08, 0.17, 0.19, 0.08], ["MILACKI", 0.14, 0.16, 0.2, 0.08], ["Born: July 28, 1964", 0.22, 0.19, 0.17, 0.045]]);
    expect(milacki).toMatchObject({ player: "Bob Milacki", playerAgree: true });
  });

  it("splits a front name read without its space at the back's surname", () => {
    const p = parse([["BOBMILACKI", 0.82, 0.24, 0.52, 0.075]], [["ROBERT", 0.08, 0.17, 0.19, 0.08], ["MILACKI", 0.14, 0.16, 0.2, 0.08], ["Trenton, NJ", 0.26, 0.26, 0.1, 0.043]]);
    expect(p.player).toBe("Bob Milacki");
    // Without a back there is nothing to split it with: no name.
    expect(parse([["BOBMILACKI", 0.82, 0.24, 0.52, 0.075]], null).player).toBeNull();
  });

  it("keeps a suffix shown on either side with the same name", () => {
    const cut = parse([["KEN GRIFFEY, J", 0.9, 0.32, 0.67, 0.05]], [["Ken Griffey, Jr. • OF", 0.02, 0.24, 0.57, 0.15], ["YR CLUB G AB R H", 0.24, 0.13, 0.7, 0.05]]);
    expect(cut.player).toBe("Ken Griffey Jr.");
    expect(parse([["CAL RIPKEN JR.", 0.88, 0.1, 0.6, 0.06]], [["CAL RIPKEN", 0.05, 0.2, 0.5, 0.06]]).player).toBe("Cal Ripken Jr.");
    // A father and son on two cards: no suffix read, none added.
    expect(parse([["KEN GRIFFEY", 0.9, 0.3, 0.6, 0.05]], null).player).toBe("Ken Griffey");
  });

  it("leaves the name blank when a large heading on the back names someone else", () => {
    const p = parse([["MARK LEMKE", 0.88, 0.1, 0.6, 0.06]], [["TOMMY GREGG", 0.05, 0.2, 0.6, 0.08], ["Bats: Left Throws: Left", 0.15], ["Born: 7-29-63", 0.2], ["Home: Atlanta", 0.25]]);
    expect(p.player).toBeNull();
  });
});

describe("year, card first", () => {
  it("takes the set year printed with the maker on the front, also when read as two boxes", () => {
    const front: Row[] = [["DONRUSS", 0.09, 0.08, 0.56, 0.028], ["1992", 0.09, 0.59, 0.31, 0.023], ["BOB MILACKI", 0.82, 0.24, 0.5, 0.07]];
    const back: Row[] = [["© 1991 LEAF, INC PRINTED IN U.S.A", 0.29, 0.09, 0.03, 0.3]];
    expect(parse(front, back).year).toBe(1992);
    expect(parse([["'93-94 FLEER", 0.04, 0.7, 0.25, 0.05]], null).year).toBe(1993);
    expect(parse([["93-94 FLEER ULTRA", 0.04, 0.7, 0.25, 0.05]], null).year).toBe(1993);
  });

  it("from the copyright year and the stat table: the same year means the next year's set", () => {
    const rows: Row[] = [
      ["Year Team ERA G IP H R ER BB SO", 0.75, 0.09, 0.6, 0.03],
      ["1990 Orioles 4.46 27 135 143 73 67 61 60", 0.86, 0.09, 0.6, 0.03],
      ["1991 Orioles 4.01 31 184 175 86 82 53 108", 0.9, 0.09, 0.6, 0.03],
    ];
    expect(parse(null, [["© 1991 LEAF, INC.", 0.95], ...rows]).year).toBe(1992);
    expect(parse(null, [["© 1992 LEAF, INC.", 0.95], ...rows]).year).toBe(1992);
    // Stats later than the copyright cannot be settled: no year.
    expect(parse(null, [["© 1990 LEAF, INC.", 0.95], ...rows]).year).toBeNull();
  });

  it("reads a stat table the reader cut into cells", () => {
    const cells: Row[] = [];
    for (const [i, y] of [1989, 1990, 1991].entries()) {
      const top = 0.8 + i * 0.04;
      cells.push([String(y), top, 0.09, 0.04, 0.03], ["Orioles", top, 0.14, 0.05, 0.03], ["4.01", top, 0.21, 0.04, 0.03], ["31", top, 0.26, 0.03, 0.03]);
    }
    const p = parse(null, [["© 1991 LEAF, INC.", 0.3, 0.09, 0.03, 0.3], ...cells]);
    expect(p.year).toBe(1992);
  });

  it("with two copyright years, takes the one on the maker's line", () => {
    const back: Row[] = [["©1988 USOC", 0.89, 0.55, 0.14, 0.017], ["©1991 Impel Marketing Inc. 36 USC 380", 0.91, 0.05, 0.44, 0.021]];
    const p = parse(null, back);
    expect(p).toMatchObject({ year: 1991, brand: "Impel" });
  });

  it("never takes a birth year, a class year or a year in the bio", () => {
    const back: Row[] = [["Class of 1984", 0.22, 0.43], ["Date of birth: June 30, 1938", 0.25, 0.43], ["During the 1964 Tokyo Olympic Games he became the", 0.47, 0.07, 0.85]];
    expect(parse(null, back).year).toBeNull();
  });
});

describe("brand and set", () => {
  it("reads the usual makers from the copyright line", () => {
    for (const [line, brand] of [
      ["© 1991 Impel Marketing Inc.", "Impel"],
      ["© 1993 FLEER CORP.", "Fleer"],
      ["© 1990 PRO SET INC.", "Pro Set"],
      ["© 1991 SKYBOX INTERNATIONAL", "SkyBox"],
      ["© 1992 PACIFIC TRADING CARDS, INC.", "Pacific"],
      ["© 1990 O-PEE-CHEE CO. LTD.", "O-Pee-Chee"],
      ["© 1994 PLAYOFF CORP.", "Playoff"],
      ["© 2020 PANINI AMERICA, INC.", "Panini"],
      ["© 1991 ACTION PACKED, INC.", "Action Packed"],
    ]) {
      expect(parse(null, [[line, 0.95, 0.1, 0.8, 0.02]]).brand, line).toBe(brand);
    }
  });

  it("finds the maker in a copyright line read without its spaces", () => {
    expect(parse(null, [["D\u00a91990 THETOPPS", 0.68, 0.83, 0.02, 0.31]])).toMatchObject({ brand: "Topps", year: 1990 });
    expect(parse(null, [["\u00a91989UPPERDECKCO.", 0.95]]).brand).toBe("Upper Deck");
  });

  it("a logo name beats the copyright owner", () => {
    expect(parse([["DONRUSS", 0.09, 0.08, 0.5, 0.03]], [["© 1991 LEAF, INC.", 0.95]]).brand).toBe("Donruss");
    expect(parse([["SCORE", 0.04, 0.05, 0.25, 0.05]], [["© 1995 PINNACLE BRANDS, INC.", 0.95]]).brand).toBe("Score");
    expect(parse([["LEAF", 0.04, 0.05, 0.25, 0.05]], [["© 1991 LEAF, INC.", 0.95]]).brand).toBe("Leaf");
  });

  it("names the set only when it is read, never the brand copied in", () => {
    expect(parse([["FLEER", 0.04, 0.77, 0.14, 0.06]], [["1993 FLEER CORP. PRINTED IN U.S.A.", 0.48, 0.91, 0.03, 0.5]])).toMatchObject({ brand: "Fleer", setName: null });
    expect(parse([["ULTRA", 0.04, 0.77, 0.14, 0.06]], [["© 1993 FLEER CORP.", 0.95]])).toMatchObject({ brand: "Fleer", setName: "Fleer Ultra" });
    expect(parse([["STADIUM CLUB", 0.04, 0.05, 0.4, 0.05]], [["© 1992 THE TOPPS COMPANY, INC.", 0.95]])).toMatchObject({ brand: "Topps", setName: "Stadium Club" });
    expect(parse([["PRIZM", 0.04, 0.05, 0.25, 0.05]], [["© 2020 PANINI AMERICA, INC.", 0.95]])).toMatchObject({ brand: "Panini", setName: "Prizm" });
    expect(parse([["SELECT", 0.04, 0.05, 0.25, 0.05]], [["\u00a9 1993 PINNACLE BRANDS, INC.", 0.95]]).setName).toBe("Select");
  });

  it("Score Board, Inc. is not the Score brand", () => {
    expect(parse(null, [["© 1992 SCORE BOARD, INC.", 0.95]]).brand).toBe("Score Board");
  });
});

describe("card number", () => {
  it("takes a short number standing alone in a corner of the back", () => {
    expect(parse(null, [["65", 0.07, 0.07, 0.09, 0.09], ["TIM HARDAWAY", 0.74, 0.15, 0.3, 0.06]]).cardNumber).toBe("65");
    expect(parse(null, [["WILLIAM MERVIN MILLS", 0.05, 0.07, 0.77, 0.06], ["24", 0.13, 0.84, 0.08, 0.04]]).cardNumber).toBe("24");
  });

  it("never takes a stat cell, a year, a decimal or a jersey number on the front", () => {
    const table: Row[] = [["37", 0.82, 0.08, 0.02, 0.03], ["243", 0.82, 0.12, 0.04, 0.03], ["233", 0.82, 0.17, 0.04, 0.03]];
    expect(parse(null, table).cardNumber).toBeNull();
    expect(parse(null, [["1989", 0.05, 0.05, 0.06, 0.03], ["3.74", 0.9, 0.85, 0.05, 0.03]]).cardNumber).toBeNull();
    expect(parse([["10", 0.05, 0.05, 0.1, 0.1], ["24", 0.85, 0.85, 0.1, 0.1]], null).cardNumber).toBeNull();
  });

  it("two different numbers in the top corners: none", () => {
    expect(parse(null, [["65", 0.05, 0.05, 0.08, 0.06], ["12", 0.05, 0.85, 0.08, 0.06]]).cardNumber).toBeNull();
  });

  it("a marker beats a number in a bottom corner", () => {
    expect(parse(null, [["CARD NO. 280", 0.5, 0.3, 0.3, 0.03], ["24", 0.9, 0.85, 0.05, 0.04]]).cardNumber).toBe("280");
    expect(parse(null, [["24", 0.9, 0.85, 0.05, 0.04]]).cardNumber).toBe("24");
  });
});

describe("team and sport", () => {
  it("Athletics with Olympic words is track and field: sport other, no team", () => {
    const p = parse([["U.S. OLYMPIC CARDS", 0.06, 0.25, 0.38, 0.04], ["BILLY MILLS", 0.86, 0.27, 0.5, 0.05], ["Athletics", 0.9, 0.43, 0.19, 0.03]], [["Athletics", 0.2, 0.43], ["Official Licensee of the U.S. Olympic Committee", 0.92, 0.26, 0.47, 0.018]]);
    expect(p).toMatchObject({ sport: "other", team: null, teamHint: null });
  });

  it("a bio that mentions Olympic gold does not make an Olympic card", () => {
    const p = parse(null, [
      ["MICHAEL JORDAN", 0.05, 0.3, 0.5, 0.05],
      ["YEAR TEAM G MIN FGA FTA REB AST PTS AVG", 0.5],
      ["84-85 CHICAGO BULLS 82 3144 1625 746 534 481 2313 28.2", 0.55],
      ["He won Olympic gold with the U.S. team in 1984.", 0.7],
    ]);
    expect(p.sport).toBe("basketball");
    expect(p.team).toBe("Chicago Bulls");
  });

  it("a nickname needs its city or a sign of its sport", () => {
    expect(parse([["ATHLETICS", 0.9, 0.4, 0.3, 0.04]], null).team).toBeNull();
    expect(parse([["ATHLETICS", 0.9, 0.4, 0.3, 0.04]], [["YR CLUB G AB R H HR RBI AVG", 0.3]]).team).toBe("Oakland Athletics");
    expect(parse([["OAKLAND ATHLETICS", 0.9, 0.4, 0.3, 0.04]], null).team).toBe("Oakland Athletics");
  });

  it("a position must fit the sport: a basketball card gets no hockey position", () => {
    const back: Row[] = [["YEAR CLUB FG% FT% REB AST STL BLK PTS AVG", 0.84, 0.1, 0.5, 0.04], ["LW", 0.5, 0.5, 0.05, 0.03]];
    const p = parse(null, back);
    expect(p.sport).toBe("basketball");
    expect(p.position).toBeNull();
  });
});

describe("serial numbers and autographs", () => {
  it("a date in running text is never a serial number", () => {
    expect(parse(null, [["14/91.. Plagued by shoul-", 0.39, 0.7, 0.23, 0.045]]).serialRead).toBeNull();
    expect(parse(null, [["pitchers to no-hit A's 7/14/91", 0.36, 0.7, 0.22, 0.045]]).serialRead).toBeNull();
    expect(parse(null, [["Yankees 9/28/88...Came", 0.66, 0.7, 0.22, 0.042]]).serialRead).toBeNull();
    expect(parse(null, [["Traded to Seattle on July 12/90", 0.6]]).serialRead).toBeNull();
  });

  it("a print run stamped on its own is still read", () => {
    expect(parse([["12/99", 0.9, 0.8, 0.1, 0.03]], null).serialRead).toMatchObject({ text: "12/99", weak: false });
    expect(parse([["SERIAL NUMBERED 045/100", 0.9, 0.5, 0.4, 0.03]], null).serialRead).toMatchObject({ text: "045/100" });
  });

  it("'signed by' a team or as a free agent is not an autograph", () => {
    for (const line of ["in '87..Signed by Orioles", "Signed as a free agent by the Mets", "SIGNED BY ORIOLES AS A FREE AGENT, 6/87", "Re-signed with the Bulls in 1996"]) {
      expect(parse(null, [[line, 0.6]]).isAutograph, line).toBe(false);
    }
    expect(parse(null, [["He threw his signature slider for strikes", 0.6]]).isAutograph).toBe(false);
  });

  it("autograph wording on the card or a sticker is still read", () => {
    expect(parse([["CERTIFIED AUTOGRAPH", 0.85, 0.1, 0.5, 0.03]], null).isAutograph).toBe(true);
    expect(parse([["AUTHENTIC AUTOGRAPH", 0.85, 0.1, 0.5, 0.03]], null).isAutograph).toBe(true);
    expect(parse([["AUTO", 0.85, 0.8, 0.1, 0.03]], null).isAutograph).toBe(true);
  });
});

describe("cards from other sports and eras (adversarial)", () => {
  it("a 1991 Score football card", () => {
    const front: Row[] = [["SCORE", 0.04, 0.05, 0.2, 0.04], ["BARRY SANDERS", 0.88, 0.1, 0.6, 0.06], ["LIONS RB", 0.94, 0.6, 0.3, 0.03]];
    const back: Row[] = [
      ["31", 0.04, 0.88, 0.06, 0.04],
      ["BARRY SANDERS", 0.05, 0.25, 0.5, 0.05],
      ["Running Back • Oklahoma State", 0.11, 0.25, 0.5, 0.03],
      ["YEAR TEAM RUSHING ATT YDS AVG TD", 0.5, 0.1, 0.8, 0.03],
      ["89 Lions 280 1470 5.3 14", 0.55, 0.1, 0.8, 0.03],
      ["90 Lions 255 1304 5.1 13", 0.59, 0.1, 0.8, 0.03],
      ["© 1991 SCORE • Printed in U.S.A.", 0.96, 0.1, 0.8, 0.02],
    ];
    expect(parse(front, back)).toMatchObject({
      player: "Barry Sanders", year: 1991, brand: "Score", cardNumber: "31", sport: "football", team: "Detroit Lions", position: "RB",
    });
  });

  it("a 1990-91 O-Pee-Chee hockey card", () => {
    const front: Row[] = [["O-PEE-CHEE", 0.04, 0.05, 0.3, 0.04], ["WAYNE GRETZKY", 0.88, 0.1, 0.6, 0.06], ["KINGS", 0.93, 0.7, 0.2, 0.03]];
    const back: Row[] = [
      ["1", 0.04, 0.06, 0.04, 0.04],
      ["WAYNE GRETZKY", 0.05, 0.25, 0.5, 0.05],
      ["CENTRE", 0.1, 0.25, 0.2, 0.03],
      ["SEASON CLUB GP G A PTS PIM", 0.5, 0.1, 0.8, 0.03],
      ["88-89 Kings 78 54 114 168 26", 0.55, 0.1, 0.8, 0.03],
      ["89-90 Kings 73 40 102 142 42", 0.59, 0.1, 0.8, 0.03],
      ["NATIONAL HOCKEY LEAGUE", 0.9, 0.1, 0.6, 0.02],
      ["© 1990 O-PEE-CHEE CO. LTD. PRINTED IN CANADA", 0.96, 0.1, 0.8, 0.02],
    ];
    expect(parse(front, back)).toMatchObject({
      player: "Wayne Gretzky", year: 1990, brand: "O-Pee-Chee", cardNumber: "1", sport: "hockey", team: "Los Angeles Kings",
    });
  });

  it("a modern Panini Prizm card numbered 12/99", () => {
    const front: Row[] = [["PRIZM", 0.04, 0.05, 0.2, 0.04], ["JUSTIN HERBERT", 0.88, 0.1, 0.6, 0.06], ["12/99", 0.93, 0.8, 0.12, 0.03]];
    const back: Row[] = [
      ["280", 0.04, 0.85, 0.08, 0.04],
      ["JUSTIN HERBERT", 0.05, 0.1, 0.6, 0.06],
      ["QB", 0.11, 0.1, 0.1, 0.03],
      ["LOS ANGELES CHARGERS", 0.15, 0.1, 0.6, 0.03],
      ["© 2020 Panini America, Inc. Officially Licensed Product of NFL Players", 0.96, 0.05, 0.9, 0.02],
    ];
    const p = parse(front, back);
    expect(p).toMatchObject({ player: "Justin Herbert", year: 2020, brand: "Panini", setName: "Prizm", cardNumber: "280", sport: "football", team: "Los Angeles Chargers" });
    expect(p.serialRead).toMatchObject({ text: "12/99", weak: false });
  });

  it("an autograph card with a sticker", () => {
    const front: Row[] = [["UPPER DECK", 0.04, 0.05, 0.3, 0.04], ["KEN GRIFFEY JR.", 0.86, 0.1, 0.6, 0.06], ["CERTIFIED AUTOGRAPH", 0.92, 0.1, 0.5, 0.03]];
    const p = parse(front, [["© 1999 The Upper Deck Company, LLC", 0.96, 0.05, 0.9, 0.02]]);
    expect(p).toMatchObject({ player: "Ken Griffey Jr.", year: 1999, brand: "Upper Deck", isAutograph: true });
  });
});
