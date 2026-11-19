/**
 * Common given names and short forms of players on sports cards (mostly men's
 * names: English, Spanish, French and other names common in the four big
 * leagues). Used only to spot a first name with one misread letter ("Fose"
 * for "Jose"): a name not on this list that is one letter away from a name on
 * it is suspect. A name missing from the list is never changed by itself.
 * Lower case, letters only.
 */
const NAMES = `
aaron abe abel abraham adam adolfo adrian agustin al alan albert alberto albie alex alexander alexei alexis alfonso
alfred alfredo ali allan allen alonzo alvaro alvin amari amos anders andre andrea andreas andres andrew andy angel
angelo anthony antoine anton antonio archie ariel armando arnold arthur artie arturo austin avery barry bart ben
benito benjamin bennie benny bernard bernie bert bill billy blaine blair blake bo bob bobby boone brad bradley brady
brandon brendan brent brett brian brice brock brooks bruce bryan bryant bryce bubba bud buddy burt butch byron cal
caleb calvin cam cameron carl carlos carlton carmelo carson carter casey cecil cedric cesar chad charles charlie
chase chauncey chet chris christian christopher chuck clarence clark claude clay clayton clem cliff clifford clint
clinton clyde cody colby cole colin connor corey cory craig curt curtis dale dallas dalton damian damon dan dana
daniel danny dante darin dario darius darnell darrell darren darryl daryl dave david davis dean dennis denny derek
derrick devin dewayne dexter dick diego dion dirk dmitri dom dominic dominique don donald donnie donovan doug douglas
drew duane dustin dusty dwayne dwight dylan earl earnest ed eddie edgar edgardo eduardo edward edwin eli elias eliot
elliott elmer elvis emanuel emil emilio emmanuel emmitt enrique eric erik ernest ernie esteban ethan eugene evan
everett fabian felipe felix fernando fidel francisco frank frankie franklin fred freddie freddy frederick gabe
gabriel garrett garry gary gene geoff george gerald gerardo gil gilbert glen glenn gonzalo gordon grady graham grant
greg gregg gregory gus guy hal hank hanley harold harris harry harvey hector henry herb herbert herman hideki homer
horace howard howie hubert hugh hugo ian ignacio isaac isaiah ismael ivan jack jackie jackson jacob jake jamal james
jamie jared jarrod jason javier jay jean jeff jefferson jeffrey jerome jerry jesse jesus jim jimmie jimmy joaquin joe
joel joey john johnnie johnny jon jonathan jordan jorge jose josh joshua juan julian julio justin karl keith kelly
ken kendall kenny kent kerry kevin kirk kurt kyle lamar lance larry lawrence lee leo leon leonard leroy les lester
lewis lloyd lonnie lou louis lucas luis luke lyle mac malcolm manny manuel marc marcel marcus mario mark marshall
martin marty marv marvin mason matt matthew maurice max melvin mickey miguel mike miles milt milton mitch mitchell
moises monte morris moses murray nate nathan neal neil nelson nick nicholas nicky noah noel nolan norm norman oliver
omar orlando oscar otis owen pablo paco pat patrick paul pedro pete peter phil philip phillip pierre preston quinn
rafael ralph ramon randall randy ray raymond reggie rene rex ricardo rich richard richie rick rickey ricky rob robbie
robert roberto robin rod rodney roger roland rolando ron ronald ronnie ross roy ruben rudy russ russell ryan sal
salvador sam sammy samuel scott sean sergio seth shane shaun shawn sid sidney simon stan stanley stephen steve steven
stu stuart sylvester ted teddy terrence terry thomas tim timothy toby todd tom tommy tony travis trent trevor troy
ty tyler tyrone vernon vic victor vince vincent wade wally walt walter warren wayne wendell wes wesley will willie
william willis wilson xavier zach zachary zack
`;

export const GIVEN_NAMES: ReadonlySet<string> = new Set(NAMES.split(/\s+/).filter(Boolean));
