// CEFR level word lists (A1→C2). Words not found here → C1/C2 by default.
// Source: Oxford 3000 / CEFR vocabulary lists (condensed)

const CEFR_LEVELS = (function () {
  const A1 = new Set(`
a able about above across after again ago all allow already also always am an and another any
are around as ask at away back bad be because become before behind big book both boy bring but
by call can car child children city class come could country day different do down drink drive
eat even every face family far father feel few find first follow for friend from front get
girl give go good great hand have he help her here him his home how i if in it its job
just keep know large last learn leave let life light like live long look lot love make man
many me mean meet might money month more most much my name need never new next nice night
no not now number of off ok old on once one only open or other our out over own
part people place play please put read right run same say school see she show sit small
some something start student study take talk tell than that the their them then there they
think this time to today together too town train try under understand use very want was
way we well what when where which while who why will with work world would write year yes
you young your
`.trim().split(/\s+/));

  const A2 = new Set(`
accept across activity afternoon agree air airport already although animal answer appear
area arrive art ask aunt autumn baby bank beach because become belong beside best between
boat body book boss both break breakfast bridge brother build business busy buy cafe
camera cheap check choose class clean clever close clothes club color colour comfortable
company compare complete computer corner correct cost couple course create cross culture
cut dance dark daughter dear decide describe design difference difficult direction discover
drink drive during early easy else email enjoy enough evening example exercise expensive
explain eye fall fast favorite favourite fine finish flat floor fly follow food free
fresh future garden gate grow happy hard hat hate have health heavy hello holiday hospital
hotel hour house hungry idea important inside interesting invite island job journey key
kind kitchen lake language late later laugh leave letter library listen little local
low lucky lunch magazine map market match maybe meal member message middle mind mistake
moment morning mountain move museum music near necessary next notice often outside park
pass perfect phone picture plan point popular possible post practice prepare price problem
produce program programme project quiet quite rain ready real reason receive recommend
remember rent repeat rest restaurant return ride road rule sad safe save science send
sentence shopping short simple sister size sky sleep slow small smile snow social soft
sometimes son sorry sound special spend sport station step still stop store strange street
strong subject successful summer sure surprised swim table teacher team test thank ticket
tired together top tour tree trouble true turn tv typical umbrella unit visit wait warm
weather weekend well-known wide winter wish wonderful word young
`.trim().split(/\s+/));

  const B1 = new Set(`
ability abroad absolutely abstract achieve action adapt additional address administration
advantage adventure advice affect afford afraid age agency agree agreement ahead aid aim
airline alert allow alternative although amazing analysis announce anyway apply approach
appropriate approve approximately argue arrange aspect assistant association attempt
attend attitude audience available award aware awful background basic basis behavior
behaviour believe benefit border brain branch brave brief broadly budget capability capital
career cause certainly charge claim climate clue colleague collect combination comment
commission communicate community compare competition complex concerned conclusion
confidence confirm connect consider consist contact content continue contribute control
conversation convince correct couple cover debate decision deep definitely demand despite
develop difference digital direction directly discuss distance doubt due editor education
effect efficient effort elect electronic element emergency encourage environmental equal
especially establish evaluate even event evidence exact exactly examine except exchange
exclude exist expand expect experience experiment expert explore express extensive extent
fact factor fail fairly faith familiar feature feeling finance fit focus force formal
forward fundamental future generation handle happen hardly hide highlight historical
honest identify immediate impact improve income increase independent individual influence
inform institution intelligence invest involve issue item latest legal level limited link
likely logical loss major manage meaning mention method might minor mistake model modern
network normal notice objective obvious occur official option order organize organise
outcome own participate particular pay period perspective physical plan politics prefer
prepare present pressure previous primary principle produce profit provide public purpose
quality question quite range reach reduce refer regular relation release remember require
research resource response responsibility result risk role situation skill solve source
spend standard structure suggest support temporary tend theory throughout trend trust type
unique unless unlikely update urgent value view virtual volunteer vote waste watch whole
widely willing wonder worth
`.trim().split(/\s+/));

  const B2 = new Set(`
abstract abundance accelerate accommodate accomplish accumulation accurate acquisition
acute adaptation adjacent adjacent adjust administration adolescent advocate aesthetic
aftermath agenda aggregate aid alienate allocate ambiguous ambiguous analyze annual
anticipate apparent application approximate arbitrary assess assignment assumption
attribute authentic automation benchmark bias boundary brief broad calculate capacity
capacity category challenge characteristic clarity collaborate comprehensive concentrate
consequently constitute constraint context contradict contribution controversy convinced
coordination correspond criteria critique crucial data decade decline dedicate define
deliberate demonstrate derive deviation dimension discipline disposal distinct diversify
domain duration dynamic economy elaborate emerge emphasis encounter enforce enhance
enormous enterprise entity establish evaluate evaluate exclude execution explicit expose
facilitate factor feasible flexible fluctuate framework foundation generate generalize
global gradually highlight hypothesis illustrate implication implicit incorporate
indicator individual infrastructure insight integral integration interval investigate
justify labor labour layout limitations logic mainstream marginal mechanism migration
minimize notable notion objective obtain organize perspective portfolio preliminary
priority procedure progressive promote proposing rational recognition regulate reinforce
reject relevant reliable representation resource retention scheme sector sequence
simulate sophisticated spectrum stable strategy subsequent sufficient summarize
supplement sustainable systematic target technology tension transfer transition transport
trigger ultimate undermine utilize valid validity variation vast verbal vital widespread
`.trim().split(/\s+/));

  // Build lookup map: word → level string
  const map = {};
  for (const w of A1) map[w] = 'A1';
  for (const w of A2) { if (!map[w]) map[w] = 'A2'; }
  for (const w of B1) { if (!map[w]) map[w] = 'B1'; }
  for (const w of B2) { if (!map[w]) map[w] = 'B2'; }

  return {
    getLevel(word) {
      const w = word.toLowerCase().replace(/[^a-z]/g, '');
      if (!w || w.length < 2) return null;
      return map[w] || 'C1';
    },
    COLORS: {
      A1: '#22c55e',
      A2: '#84cc16',
      B1: '#eab308',
      B2: '#f97316',
      C1: '#ef4444',
      C2: '#7c3aed',
    },
    LABELS: {
      A1: 'A1 – Başlangıç',
      A2: 'A2 – Temel',
      B1: 'B1 – Orta',
      B2: 'B2 – Üst Orta',
      C1: 'C1/C2 – İleri',
    },
  };
})();
