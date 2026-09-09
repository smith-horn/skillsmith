/**
 * SMI-6441: generated common-password lexicon for the `sensitive_path`
 * MF-4b veto (Wave 2). Vetoes MF-4's 2-token documentation-label
 * carve-out when one of the tokens is a known common password.
 * @module @skillsmith/core/security/scanner/SecurityScanner.weak-passwords
 * @generated DO NOT EDIT — produced by scripts/gen-weak-password-lexicon.mjs
 * from data/wordlists/{seclists-xato-top-10000.txt,doc-vocab-keeplist.txt}.
 * Regenerate with `npm run lexicon:weak-passwords`; verify freshness with
 * `npm run lexicon:weak-passwords:check`. A hand edit here is overwritten
 * on the next --write and is caught by the L3 --check gate before merge.
 *
 * SECURITY-RELEVANT DUPLICATION (ADR-137 Decision point 4): this file is
 * one of three byte-identical-modulo-@module copies of the same
 * generated payload —
 *   packages/core/src/security/scanner/SecurityScanner.weak-passwords.ts
 *   scripts/indexer/_shared/security-scanner-edge.weak-passwords.ts
 *   supabase/functions/_shared/security-scanner-edge.weak-passwords.ts
 * A silent divergence between these three is a SECURITY GAP, not a
 * cosmetic inconsistency: this data decides whether a `sensitive_path`
 * finding is HIGH or MEDIUM (quarantine vs. pass on the weekly scan
 * surface; blocked vs. permitted install). Enforced by three parity
 * layers: L1 Deno<->Node byte identity
 * (scripts/tests/indexer/security-scanner-edge.test.ts's
 * PATHS_FAMILY_TWINS), L2 three-way literal payload identity
 * (scripts/tests/indexer/parity-utils.ts's extractGeneratedPayload),
 * and L3 freshness/anti-hand-edit (`npm run lexicon:weak-passwords:check`,
 * wired into scripts/audit-standards.mjs).
 *
 * Source: SecLists (MIT license) — see data/wordlists/LICENSE-SecLists
 * and WEAK_PASSWORD_LEXICON_SOURCE below for exact provenance.
 *
 * Full design: docs/internal/implementation/smi-6441-weak-password-veto.md
 * See also: docs/internal/adr/149-generated-scanner-data-veto-severity-model.md
 * and docs/internal/adr/137-cross-runtime-duplication-of-security-logic.md
 */

/** Provenance of the vendored upstream snapshot this file was generated from. */
export const WEAK_PASSWORD_LEXICON_SOURCE = {
  upstream: 'https://github.com/danielmiessler/SecLists',
  path: 'Passwords/Common-Credentials/xato-net-10-million-passwords-10000.txt',
  license: 'MIT',
  commit: 'c205c36a445bff37f8e58a9ec829105cd4975c58',
  sha256: 'c63d5e4ccc31344d662583cc39ca4bd5bd20517ff1d24501f0c4e0c22d9b722a',
  sourceRankLimit: 5000,
  entries: 4012,
} as const

/** Bumped whenever the emitted entry set changes. Deterministic, no timestamp. */
export const WEAK_PASSWORD_LEXICON_VERSION = '2026-09-09.1' as const

/**
 * Lowercase-alphabetic common-password tokens, 3-19 chars, sorted, with the
 * documentation vocabulary subtracted at generation time. Exact membership
 * by design (see the ADR): the veto's failure direction is a false positive
 * on ordinary documentation, so an approximate structure is not acceptable here.
 */
export const COMMON_WEAK_PASSWORDS: ReadonlySet<string> = new Set(
  `aaaa aaaaa aaaaaa aaaaaaa aaaaaaaa aaliyah aardvark aaron abby abcd abcde abcdef abcdefg abcdefgh aberdeen abgrtyu
abigail abraham absolut accord achilles active adam adams adgjmptw adidas admiral adonis adrian adriana adrienne adult
adults aezakmi africa aggies aikido airborne airbus airforce airplane alabama alan alaska albatros albert alberto albina
albion alejandr aleksandr aleksandra aleksey alenka alex alexalex alexande alexander alexandr alexandra alexis alfa
alfred alibaba alice alicia alien aliens alina alison allen alliance allison allmine allsop allstar alpha alphabet
alpine alucard always alyssa amadeus amanda amateur amazing amazon amber amelia america american amsterda amsterdam
anaconda anakin anal analsex anarchy anastasia anders anderson andre andrea andreas andrei andres andrew andrey
andromeda andy anfield angel angela angelica angelina angelo angels angie angus anhyeuem animal animals anime anna
annette annie answer anthony antoine anton antoni antonio anubis anything apache apollo apple applepie apples april
aquarius aragorn archer archie ariana arizona arjay armagedon armani army arnold arsenal artemis arthur artist artur
asasas asdasd asdasdasd asdf asdfasdf asdfg asdfgh asdfghj asdfghjk asdfghjkl asdfjkl asdzxc ashlee ashley ashton asia
asian aspire aspirine assass assassin assfuck asshole assholes assman assword asterix astrid astros athena athens
atlanta atlantic atlantis atomic attack attitude auburn audrey august aurora aussie austin australi australia autumn
avalanch avalon avatar avenger awesome azamat azerty azsxdc azsxdcfv babe babes babies baby babybaby babyblue babyboy
babydoll babyface babygirl babylon bacardi back backdoor bacon badass badboy baddog badger badgirl baggins bagira bailey
ball baller balloon balloons balls bambam banana bananas banane bandit bang bangbang bangkok banker banshee barbara
barber barbie barcelon barcelona barefoot barkley barney barrett barry barsik bart bartman baseball basket basketba
basketball bass bassman bastard batman battle baxter bayern bbbb bbbbb bbbbbb bbbbbbbb bcfields beach beaches beagle
beamer bean beaner beanie bear bearbear bears beast beastie beatles beatrice beautifu beautiful beauty beaver beavis
because beckham becky beefcake beer beerbeer beetle believe belinda bell bella belle bender benfica bengals benjamin
bennett benny benson bentley beowulf beretta berlin bermuda bernard bernie bert bertha bertie bethany better betty
beverly bianca bicycle bigass bigballs bigbear bigbird bigboobs bigboy bigbutt bigcock bigdaddy bigdick bigdog bigfoot
bigger biggie biggles bigguy bigmac bigman bigmike bigmoney bigone bigred bigsexy bigtime bigtits bike bikini bill
billie billy billybob billyboy bimmer bing bingo bird birdie birdman birthday biscuit bishop bitch bitchass bitches
biteme bizkit blabla blablabla black blackbir blackcat blackdog blackhaw blackie blackjac blackjack blackman blacks
blacky blade blades blahblah blake blaster blazer blessed blessing blizzard blonde blondes blondie blood bloody blossom
blow blowjob blowme blue bluebird blueblue blueboy bluedog blueeyes bluemoon blues bluesky boat bobafett bobbie bobbob
bobby bobcat bobo bobobo boeing bogart bogdan bogey bohica bollocks bollox bomber bonbon bond bondage bone bonehead
boner bones bonita bonjour bonkers bonnie bonsai boob boobie boobies booboo boobs booger boogie booker bookworm boomboom
boomer bootie boots booty boricua boris bosco boss bossman boston bottle bottom bounce bowler bowling bowser boxing
boxster boys brad bradford bradley brandi brando brandon brandy brasil braves bravo brazil breast breeze brenda brendan
brent brewer brewster brian briana brianna bridge bridget bright brighton bristol britney brittany broadway broken
bronco broncos brooke brooklyn brooks brother brothers brown brownie browns bruce brucelee bruins bruno brutus bryan
bryant bubba bubbas bubble bubbles buck bucket buckeye buckeyes buckshot buddah buddha buddie buddy budlight budman
budweise buffalo buffett buffy bugger bull bulldog bulldogs bullet bullseye bullshit bunghole bunny burger burton bush
business busted buster butch butler butt butter butterfl butterfly butthead butthole buttman buttons butts buzz buzzard
byteme cabbage cactus cadillac caesar caitlin calico caliente californ california callaway callie calvin camaro cambiami
camel camelot camels cameltoe camera cameron camilla camille campbell camper canada canadian cancer cancun candice
candle candy candyman cannabis cannon canon cantona capital capone captain caramel caravan carbon cardinal carina carl
carla carlo carlos carlton carmel carmen carol carole carolina caroline carolyn carpet carrera carrie carrot carson
carter cartman cartoon casanova caserta casey cash casino casper cassidy cassie castle catalina catcat catdog catfish
catherin catherine catman cats cavalier caveman ccbill cccccc cdtnkfyf cecilia cedric celeron celeste celica celine
celtic celtics ceng center central century cerberus cessna cfitymrf cgfhnfr chacha chad chai chainsaw chair champ
champion champs chance chandler chanel chang changed changeme chao chaos charger chargers charity charlene charles
charley charli charlie charlott charlotte charlton charly charmed chase chaser cheater checkers cheeks cheers cheese
cheetah chelsea chemical cheng cherokee cherry cheryl chester chevelle chevrole chevy chewie cheyenne chicago chichi
chicken chickens chicks chico chief chiefs children china chinook chip chipper chivas chloe chocolat chocolate chong
chopper chou chris chrisbln chrissy christ christia christian christie christin christina christine christmas christop
christopher christy chronic chrono chuai chuang chubby chuck chuckles chucky chun chunky chuo church cicero cigars
cinder cindy cinema cinnamon circle circus city cjkysirj cjkywt claire clancy clapton clarence clarinet clark classic
claude claudia claudio claymore clayton clemson clevelan clifford clinton clipper clitoris clouds clover clown cobra
cocacola cocaine cock cocks coco coconut cody coffee cohiba coke coleman colleen college collin collins colombia
colorado colors coltrane columbia columbus combat comet comics commando compaq computer concrete condom condor confused
cong conner connie connor conrad consumer cookies cool cooldude cooler coolguy coolio coolman cooper cooter copper
cornell corona corrado corvette cosmo cosmos cosworth cotton coucou cougar country courage courtney cowboy cowboys
coyote cracker craig crash crawford crazy crazybab cream creampie creamy creative credit cricket crimson cristina
critter crjhgbjy crow cruise cruiser crunch crusader crysis crystal cthulhu cthutq cubbies cubswin cuddles cumming
cumshot cunt cunts cupcake curious curtis custom cutlass cutter cxfcnmt cyber cyclone cyclops cynthia cypress dada
dadada daddy daewoo dagger daisy dakota dale dalejr dallas dalton damage damian damien dammit damnit dana dance dancer
dang danger danie daniel daniela danielle daniil danila danni danny dannyboy dante danzig daphne dark darkman darkness
darkside darkstar darling darren darwin dave david davids davidson davis dawg dawn dawson daytona dbrnjh dbrnjhbz dddd
ddddd dddddd ddddddd dddddddd deacon dead deadhead deadman dean deanna death debbie deborah december deedee deejay
deepthroat deeznuts deeznutz defender defiant deftones delphi delta deluxe demon demons denali deng denis denise deniska
dennis denver depeche derek derrick desert designer desire deskjet destiny destroy detroit devil devildog devils dexter
dfkthbz dfkthf dfktynbyf dfvgbh dharma diablo diamond diamonds dian diana diao dick dickhead dicks diehard diesel
dietcoke digger diggler dilbert dildo dilligaf dillon dima dinamo ding dingdong dino dinosaur director dirty discover
disney divine dixie dkflbckfd dkflbvbh doberman doctor dodge dodger dodgeram dodgers dogdog dogfood dogg doggie doggy
doghouse dogman dogs dollar dollars dolphin dolphins dominic domino donald dong donkey donna donnie donuts doobie doodle
doodoo doogie dookie dorian dorothy double doudou doug doughboy douglas downtown dracula drago dragon dragonball dragons
dragoon drake dream dreamer dreams drew drizzt droopy drowssap drpepper drummer dthjybrf dublin ducati duchess duck dude
dudley duke dumbass duncan durango duster dustin dusty dutch dutchess dylan eagle eagles eastside easy eatme eatpussy
eatshit eclipse eddie eduard eduardo edward edwards eeeeee eeyore eileen einstein ekaterina elaine eleanor electric
elena elephant eleven elijah elizabet elizabeth elliot elliott elvira elvis elwood emerald emerson emily eminem emma
emmanuel emmitt empire energy engage england english enigma enjoy enter enterpri eraser eric erica ericsson erik ernest
erotic erotica escape escort esther eternal eternity eugene eureka europa europe evelyn everest everton excalibu exigen
exigent exodus explorer express extreme fabian face facial faggot faith falcon falcons fallen fallout family famous fang
fantasy farmer farside fart fashion fast faster fatass fatboy fatcat father fatima fatman feather february federico feet
felicia felipe felix fender feng fernand fernando ferrari ferret ferris fester fetish fffff ffffff fghtkm ficken fiesta
figaro fighter filthy finger fingers finish fire fireball firebird firefly firefox fireman first fish fisher fishes
fishing fisting fitness five fktrcfylh fktrcfylhf fktrctq flames flamingo flash flatron fletch fletcher flexible flight
flipper floppy florence florian florida flounder flower flowers floyd fluffy flyboy flyers flying focus foobar footbal
football ford forest forever forfun forget forgot formula forrest fortuna fortune fossil foster fowler foxtrot france
frances francesc francis franco francois frank frankie franklin franky freak freaks freaky freckles fred freddie freddy
frederic fredfred free freedom freeman freepass freeporn freeuser freeze french fresh friday friend friends fright
frisco frisky fritz frodo frog frogger froggy frontier frosty frozen fubar fuck fucked fucker fuckers fuckface fuckfuck
fuckher fuckin fucking fuckit fuckme fuckoff fuckthis fucku fuckyou fugazi funfun funny funtime fusion futbol future
fuzzy fyfcnfcbz fylhtq fytxrf gabrie gabriel galaxy galina galore gambit gamecube gameover games gandalf gang gangbang
gangsta gangster garage garbage garcia garden garfield gargoyle garrett gary gaston gator gators gawker gbpltw gegcbr
geheim gemini general genesis genius george georgia gerald gerard german germany geronimo gesperrt getmoney getsome
gfhjkm gggg gggggg gggggggg ghbdtn ghbdtnbr ghblehjr ghetto ghjcnj ghjcnjnfr ghost ghostrider giant giants gibson
gilbert gillian ginger giorgi giovanni girl girls giuseppe gizmo gizmodo gjkbyf gladiator gloria glory gmoney goalie
goaway goblin goblue gobucks goddess godfather godsmack godzilla gofish goforit gogo gogogo goku gold goldberg golden
goldfish goldie goldstar goldwing golf golfball golfer golfgolf golfing goliath gollum gonavy gong gonzo goober good
goodboy goodbye goodluck goodman goodtime goofy google goose gopher gordon gorilla gotcha gothic gotohell govols grace
gracie graham grandma granny grant grapes grateful great greatone greece green greenbay greenday greene greens greg
gregory gremlin grendel gretchen gretzky griffey griffin gringo grizzly gromit groove groovy groucho grover grumpy guai
guardian guiness guinness guitar gundam gunnar gunner gunners gustav hacked hacker haha hahaha hahahaha hailey hairy
halflife hallo hambone hamburg hamilton hamlet hammer hammers hampton hamster handsome handyman hang hank hanna hannah
hannibal hansen hansolo happy happyday hard hardcock hardcore harder hardon hardrock harley harmony harold harper harris
harrison harry harvey hastings havefun hawaii hawk hawkeye hawkeyes hayabusa hayden hayley head health heart hearts
heather heaven heckfy hector hedgehog hehehe heidi helen helena hell hellfire hello helloo hellyeah helmet help helpme
hendrix henry hentai herbert herbie hercules herman hermes hershey hesoyam heyhey hhhhhh hidden higgins highland hihihi
hill hilton hiphop hippie hithere hitler hitman hjvfirf hobbes hobbit hockey hohoho hokies holden holiday holland holly
hollywoo hollywood holmes holyshit home homer homers homerun honda honey hong hongkong hooker hoosier hoosiers hooter
hooters hoover hope hopper horizon horndog hornet horney horny horse horses hotbox hotboy hotdog hotpussy hotred hotrod
hotsex hotshot hotstuff hottie house houses houston howard huai hudson hummer hungry hunter hunting hurley hurrican
husker huskers huskies hustler hyperion ibanez icecream iceman idiot idontkno idontknow iforgot igor iguana ihateyou
illini illinois illusion ilovesex iloveu iloveyo iloveyou imagine immortal impala imperial incubus india indian indiana
indians indigo infantry inferno infiniti infinity ingrid insane insert inside integra intel internet intrepid intruder
inuyasha ireland irina irish ironman isabel isabella isabelle isaiah island israel italia italian ivan ivanov ivanova
iverson iwantu jabroni jack jackal jackass jackie jackoff jackson jacob jade jagger jaguar jake jamaica james jamesbon
jamesbond jamie jammer jammin jane janet janice janine january japan japanese jarhead jasmin jasmine jason jasper java
javier jaybird jayden jayhawk jayjay jazz jazzman jean jeanette jeanne jedi jeep jeff jeffrey jenn jenna jennie jennifer
jenny jensen jeremiah jeremy jericho jerkoff jerome jerry jersey jess jesse jessic jessica jessie jester jesus jethro
jewels jiang jill jillian jimbo jimbob jimmy jing jiong jjjj jjjjjj jjjjjjjj jktymrf joanna joanne jockey joejoe joey
johanna johannes john johnboy johnjohn johnny johnson jojo jojojo joker jokers jonathan jones jonjon jordan jose joseph
josh joshua journey joyjoy jrcfyf juan judith juggalo juice julia julian julie juliet juliette julius jumper junebug
jungle junior jupiter justdoit justice justin justine justme juventus kahuna kaiser kaktus kamikaze kang kangaroo kansas
karate karen karina karma karolina kashmir kasper katana katerina kathleen kathryn kathy katie katrin katrina kawasaki
kaylee keegan keeper keith kelley kelly kelsey kendall kennedy kenneth kenny kenshin kentucky kenwood kenworth kermit
kevin keyboard keystone keywest kickass kicker kids kiki kill killbill killer killers killme kimber kimberly king
kingdom kingfish kingkong kingpin kingston kipper kirill kirsten kiss kisses kissing kissme kitkat kitten kitty kittycat
kittykat kkkkkk klaster klingon knickers knicks knight knights knopka kodiak kolobok kong kool korn koshka kosmos kostya
kotenok kramer krishna krista kristen kristi kristin kristina kristine kristy krystal ktyjxrf kume kungfu kyle labrador
labtec lacrosse ladies lady ladybug laguna lakers lalala lambert lamont lance lancelot lancer lang lansing laptop larisa
larry laser lasvegas latin latino laura laurel lauren laurie lawrence lawyer leader leanne leather leavemealone ledzep
leelee legacy legend legion legolas lemons leng lennon leonard leonardo leonid leopard lesbian lesbians leslie lespaul
lestat lester letmein letsgo lewis lexmark lexus liberty lick licker lickit lickme life lifehack lifetime light lighter
lightnin lightning lights lillian lilly lincoln linda lindsay lindsey ling lion lionel lionking lions lipstick liquid
lisa lisalisa little liverpoo liverpool lizard lizzie lkjhgf lkjhgfdsa llllll loaded lobster loco logan logitech
lokomotiv lola lolipop lolita lollipop lollol lolo lololo london lonely lonestar lonewolf long longhorn look looker
looking looney looser lord lorenzo lori lorraine loser losers louis louise loulou love loveit lovelove lovely loveme
lover loverboy lovers lovesex loveyou loving lowrider luan lucas lucifer lucky luckydog lucy ludwig luis luke lust
luther lvbnhbq lynn macdaddy macross madden maddie maddog madeline madina madison madman madmax madness madonna madrid
maestro maggie maggot magic magick magicman magnolia magnum magnus magpie maiden mailman majestic makaveli maksim malaka
malcolm malibu malina mallard mama mamama mamapapa manchest manchester mandingo mandy mango maniac manson manuel manutd
maradona marathon marc marcel marcia marco marcos marcus margaret margarita maria mariah marian marianne marie marika
marilyn marin marina marine mariners marines marino mario marion marisa marissa marius mark market markus marlboro
marlene marley marlin marshall martha martin martina martinez martini marvel marvin mary maryann maryjane maryland mason
massage massimo massive maste masters matador mathew matilda matt matthew mattie mature maureen maurice maverick maxell
maxim maxima maximum maximus maxine maxmax maxwell maxx mayday mayhem maynard mazafaka meatball meathead meatloaf
mechanic medical medicine medusa megadeth megaman megan megapass megatron meghan meister melanie melinda melissa mellon
mellow melody melvin mememe memorex memphis menace meng meowmeow mercedes mercury meredith meridian merlin mermaid
mersedes metal metallic metallica mexico miami mian miao michae michael michaela micheal michel michele michell michelle
michigan mickey microlab micron microsof microsoft midget midnight midway mighty miguel mike mikemike mikey milana
milano milena miles military milkman miller millie million milton mimi mine minecraft ming minime minnie miracle mirage
miranda miriam mirror misery misfit misha mishka mission missy mister mistress misty mitch mitchell mittens mmmm mmmmm
mmmmmm mmmmmmmm mnbvcx mnbvcxz mobile modena mohamed mohammed mojo mollie molly mollydog moloko molson mommy momomo
momoney monaco monalisa monday mondeo money moneyman moneys mongoose monica monika monique monke monkey monkeys monopoly
monroe monster montana monte montreal monty moocow mookie moomoo moon moonlight moose more morgan morning morpheus
morris morrison mortgage mortimer moscow mother motherfucker motherlode motley motorola mountain mouse movie movies
mozart muffin mulder multiplelo munchkin muppet murder murphy murray muscle mushroom music musica musicman mustafa
mustang mustangs mustard mybaby mylife mylove mypass myself mystery mystic nadine naked nancy napass napoleon napster
naruto nascar nasty nastya natali natalia natalie natasha nathalie nathan national natural nature naughty nebraska
nellie nelson nemesis neng neptune nevada newbie newcastl newlife newman newpass newport newton newyork nfnmzyf nguyen
niao nice nicholas nick nickel nicola nicolas nicole nigger night nike nikita nikki nikola nikolay nimbus nimrod nina
niners ninja ninjas nintendo nipper nipple nipples nirvana nissan nitram nnnnnn nobody nofear nokia nolimit none nong
nonono noodle noodles nookie nopass norman norton norway nothing nova novell november nude nudist nugget nuts
nuttertools nyjets nylons nymets oakland oakley oasis obiwan oblivion ocean october odessa office ohyeah oilers oklahoma
okokok oksana oldman oleg olga oliver olivia olivier omega onelove onetime online onlyme oooooo open openup operator
optimus oracle orange oranges orchid oregon orgasm original orioles orion orlando oscar osiris outkast outlaw overkill
overlord oxford pacers pacific packard packer packers pacman padres paint paintbal paintball painter pakistan palace
paladin palmer pamela panama panasoni panasonic pancho panda pandora pantera panther panthers panties pants pantyhos
panzer papa paper paradise paradox paris parker parola parrot party pascal pass passat passion passme passpass passport
passwd passwor passwort patches patricia patrick patriot patriots patton patty paul paula pauline pavilion payton peace
peach peaches peacock peanut peanuts pearl pearljam pebbles pedro peekaboo peewee pegasus pencil penelope peng penguin
penguins penis penny pentium people pepe pepper pepsi perfect person personal pervert pete peter peterpan peters
peterson petra peugeot peyton phantom phil philip philippe philips phillies phillip phillips philly phish phoebe phoenix
phone photo photos phpbb pianoman piao picard picasso piccolo pickle pickles pics picture pierre piglet pikachu pillow
pilot pimp pimpin pineappl ping pingpong pinhead pink pinkfloy pinky pioneer piper pippen pippin pirate pirates pisces
pissing pissoff pistol pitbull pizza pizzas planet plastic platinum play playboy player playing playstation playtime
pleasure plumber plymouth pobeda poetry poison poiuyt poiuytrewq pokemon poker polaris police polina polo polska pompey
poncho pontiac pony poochie poodle pooh poohbear pookie pool poontang poop pooper poopie poopoo pooppoop pooter popcorn
popeye popopo poppop poppy porkchop porn porno pornos pornstar porsche porter portland portugal poseidon positive possum
postal potato pothead potter powder powell power powers pppppp pppppppp precious predator prelude premier presario
presto preston pretty primus prince princes princess printer prissy privet prodigy profit prophet psycho puddin pudding
pumpkin punisher punkin punkrock puppies puppy pupsik purdue purple pussey pussie pussies pussy pussycat pussys putter
pyramid python qawsed qawsedrf qazqaz qazwsx qazwsxed qazwsxedc qazwsxedcrfv qazxsw qazxswedc qazzaq qiao qing qiong
qqqq qqqqq qqqqqq qqqqqqq qqqqqqqq quan quantum quartz quattro queen queens quincy qwaszx qweasd qweasdzxc qweqwe
qweqweqwe qwer qwerasdf qwerqwer qwert qwerty qwertyqwerty qwertyu qwertyui qwertyuio qwertyuiop qwertz qwqwqw rabbit
rabota racecar racer racerx rachael rachel racing radio rafael ragnarok raider raiders railroad rain rainbow rainman
raistlin ralph rambler rambo rammstein ramona ramses rancid randall randy ranger rangers raptor rascal rasputin rasta
rastaman raven ravens raymond rayray razz rbhbkk rctybz reader reading ready reagan reality really realmadrid reaper
rebecca rebel rebels recovery redalert redbull reddog redfish redhead redhot redline redman redneck redred redrum
redskins redsox redwing redwings redwood reebok reefer reggie regina remember renault renee renegade reng rereirf rescue
research resident respect retard retired revenge review rfhbyf rfnthbyf rfrfirf rfrnec rhbcnbyf rhfcjnrf rhiannon rhonda
rhtdtlrj ricardo rich richard richards richie richmond rick ricky rightnow riley ripken ripley ripper ripple river
rivers rjirfrgbde rjntyjr rjycnfynby roadkill roadking roadrunn robbie robert roberta roberto roberts robin robinson
robotech rock rocker rocket rockets rockford rockhard rockon rocks rockstar rocky rodman rodney roger rogers roland
roller rolling rolltide roman romance romashka romeo rommel ronald ronaldo ronnie rookie rooney rooster rootbeer roscoe
rose rosebud rosemary rosie rotten rover rovers roxanne royals rrrrrr rtyuehe ruan rubber ruby rugby rules rulez
runescape runner running rupert rush ruslan russell russia russian rustam rusty ryan sabbath sabina sabine sabres
sabrina sacred sadie safari safety sailboat sailing sailor saint saints sakura salamander saleen sally salmon salomon
salvador samantha samara samiam sammie sammy sampson samsam samson samsung samuel samurai sanchez sancho sander sanders
sandiego sandman sandra sandro sandy sang santana santiago santos sapper sapphire sara sarah saratoga sasasa sascha
sasha sassy sasuke satan satana saturday saturn saun sauron sausage savage savannah sayang scania scarface scarlet
scarlett school science scooby scoobydo scooter scorpio scorpion scotch scotland scott scottie scotty scout scrappy
scratch scream scruffy scuba scully seahawks seamus sean searay seattle sebastia sebastian second seeker seinfeld selena
seminole semperfi seng senior sentinel septembe september serega serena serenity sergei sergey sergio sersolution sesame
seven sex sexsex sexsexsex sexual sexx sexxxx sexy sexygirl sexyman shado shadow shaggy shai shalom shaman shamrock
shane shang shania shannon shaolin shark sharks sharky sharon shasta shaved shawn shazam shearer sheena shei sheila
shelby shelley shelly shemale sherlock sherman sherry sherwood shiloh shirley shit shithead shitty shogun shooter
shopping short shorty shotgun shou showme showtime shun sidney siemens sierra silence silver silvia simba simon simona
simone simple simpson simpsons sims sinatra sinbad sinclair singer single sinister sinner sirius sister sithlord sixers
skate skater skeeter skidoo skiing skinny skipper skippy skittles skorpion skydive skyline skywalke skywalker slacker
slappy slapshot slave slayer sleepy slick slider slinky slipknot slut sluts slutty small smeghead smegma smelly smile
smiles smiley smith smiths smitty smoke smoker smokes smokey smokin smoking smooth smudge smut snake snakes snapon
snapper snapple snatch sneakers snickers sniper snoop snoopdog snoopy snow snowball snowboar snowman snuggles sobaka
soccer socrates softball soldier soleil solnce solomon solution somethin something sommer song sonic sonics sony sooner
sooners sophia sophie sound southern southpar southpark spaceman spank spanking spankme spanky sparkle sparks sparky
sparrow sparta spartak spartan spartans spawn speaker spears special spectrum speed speedy spencer spider spiderma
spiderman spidey spike spirit spitfire splash splinter sponge spongebob spooky sport sporting sports spring springer
sprint sprite spunky spurs sputnik spyder squall squash squirrel squirt srinivas ssss sssss ssssss ssssssss stacey stacy
stalin stalker stallion stanford stanley staples starbuck starcraf starcraft stardust starfire starfish stargate starman
stars starship start starter startrek starwars station stealth steam steel steele steeler steelers stefan stefano stella
steph stephani stephanie stephen stereo sterlin sterling steve steven stevie stewart stick sticks sticky stimpy sting
stinger stingray stinky stocking stocks stolen stone stonecol stoned stoner stones stoney stories storm stormy strange
stranger street strider strike striker strip stripper stroke strong stuart stud student studio studly stuff stumpy
stunner stupid subaru sublime subway success suck sucker suckit suckme sucks sugar sullivan sultan summer summit
sundance sunday sunflowe sunny sunnyday sunrise sunset sunshin sunshine super superfly superman supersta superstar
supreme surf surfer surfing susan susanne suzanne suzuki sveta svetik svetlana svoboda swallow sweden sweet sweetie
sweetpea sweets sweety swimmer swimming swinger swingers sword swordfis swordfish swords sydney sylvia syncmaster
syracuse tabitha tacobell tacoma talisman tamara tammy tang tango tanker tanner tanya tara tardis tarheel tarheels
tarzan tasha tatiana tattoo tatyana taurus taylor tazman tazmania tdutybq teacher technics techno teddy teddybea teen
teens tekken telefon tempest templar temple teng tennis tequila teresa terminator terrapin terror terry testtest texas
thailand thanatos thanks thankyou theboss thecat thedog thedoors thedude theend thegame thegreat thekid theking theman
theodore theone theresa therock thesims thirteen thomas thompson thongs thor throat thuglife thumbs thumper thunder
thursday tian tickle tiffany tiger tigers tigger tight tights timber timmy timothy tina ting tinker tinkerbell tinman
tintin titanic titanium titans titleist tits titties titty tobias toby together toledo tolkien tomato tomcat tommy
tommyboy tomorrow tomtom tong tongue tony toon tootsie topcat topdog topgun topher topper tornado toronto torres toshiba
toto tottenha toyota tracey tracker tractor tracy trader traffic train trains trance transam translator trapper travel
traveler travis treasure trebor trevor trfnthbyf trial triangle tricky trident trinidad trinity trisha tristan triton
triumph trixie trojan trojans trombone trooper trouble trout truck trucker trucks truelove truman trumpet trunks tsunami
tttttt tttttttt tuan tucker tuesday tunafish tundra turbo turkey turner turtle tweety twilight twinkle twins twisted
twister tyler typhoon tyrone tyson ufkbyf ultima ultimate umbrella underdog undertaker unicorn united universe unknown
unreal usarmy usmc usnavy utopia vacation vader vagina valencia valentin valentina valera valeri valeria valerie
valhalla valkyrie valley vampire vanessa vanhalen vanilla vectra vedder vegas vegeta velvet venera venice venus verbatim
veritas vermont vernon verona veronica veronika vertigo vette vfczyz vfhbyf vfhecz vfhufhbnf vfksirf vfrcbv vfrcbvrf
vfvekz vfvfgfgf vfvjxrf viagra victor victoria victory vietnam viewsonic viking vikings viktor viktoria village vincent
vinnie violet viper vipers virgin virginia vision vitalik vivian vkontakte vladik vladimir vladislav volley volume volvo
voodoo vortex voyager voyeur vulcan vvvvvv wagner walker wallace walleye wally walmart walnut walrus walter wang wanker
warcraft wareagle warhammer warlock warlord warren warrior warriors warthog wasser wassup watcher water waterloo waters
watson wayne weasel weather weaver webmaster webster wedding weed weezer welder wendy werewolf werner wesley west
western westham westside westwood wetpussy whatever whatsup wheels whiskers whiskey whisky whisper white whitesox whitey
whitney whocares whore whynot wibble wicked wilbur wild wildcat wildcats wildfire wildman willia william williams willie
willis willow willy wilson windsor winner winnie winston winter wisdom wizard wolf wolfgang wolfie wolfman wolfpack
wolverin wolverine wolves woman wombat women wonder wood woody woofwoof woohoo wookie wordpass work working world
wrangler wrestle wrestlin wrestling wright writer wutang wwwwww xanadu xander xavier xfiles xiang xiao xiong xtreme xuan
xxxpass xxxx xxxxx xxxxxx xxxxxxx xxxxxxxx yamaha yang yankee yankees ybrbnf ybrjkfq yellow yesyes yfnfif ying yoda
yomama yosemite young yourmom yousuck yoyo yoyoyo ytrewq yumyum yvonne yzerman zachary zaphod zaqwsx zaqxsw zenith
zeppelin zero zerocool zeus zhai zhei zheng zhong zhou zhuai zhuang zhun zidane ziggy zigzag zipper zippy zombie zorro
zvezda zxcasd zxcasdqwe zxcv zxcvb zxcvbn zxcvbnm zxczxc zxzxzx zzzz zzzzz zzzzzz zzzzzzzz`
    .split(/\s+/)
    .filter(Boolean)
)
