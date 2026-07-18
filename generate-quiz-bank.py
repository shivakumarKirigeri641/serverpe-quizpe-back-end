# -*- coding: utf-8 -*-
"""Grade-1 Maths MCQ bank, June->March, cumulative spiral revision, PDF-safe."""
import json, random, os
random.seed(11)
REV_PER_MONTH = 500   # revision questions per month, STRATIFIED across all prior months
ACADEMIC_YEAR = "2026-2027"   # bump this when a new year's syllabus is added
FK_BOARDS = 1         # CBSE
FK_GRADES = 1         # Grade 1
FK_SUBJECTS = 1       # Mathematics

ONES=["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
      "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen",
      "Eighteen","Nineteen"]
TENSW={20:"Twenty",30:"Thirty",40:"Forty",50:"Fifty",60:"Sixty",70:"Seventy",
       80:"Eighty",90:"Ninety"}
def nm(n):
    if n<20: return ONES[n]
    if n==100: return "One hundred"
    t=(n//10)*10
    return TENSW[t] if n%10==0 else TENSW[t]+"-"+ONES[n%10].lower()

NAMES=["Riya","Aman","Sara","Ravi","Meena","Kabir","Nisha","Arjun","Zoya","Dev",
       "Anaya","Vihaan","Ira","Reyansh","Myra","Aarav","Kiara","Advait","Sia","Ishaan",
       "Diya","Naira","Vivaan","Anya","Rohan","Tara","Yash","Pari","Ayaan","Kabya"]
ITEMS=[("apples","🍎"),("balloons","🎈"),("pencils","✏️"),("stars","⭐"),("cookies","🍪"),
       ("flowers","🌸"),("kites","🪁"),("marbles","🔵"),("candies","🍬"),("books","📚"),
       ("fish","🐟"),("crayons","🖍️"),("bananas","🍌"),("oranges","🍊"),("shells","🐚"),
       ("leaves","🍃"),("mangoes","🥭"),("grapes","🍇"),("ducks","🦆"),("butterflies","🦋")]
def rot(s,i): return s[i%len(s)]

def plainify(s):
    keep=[ch for ch in s if ord(ch)<0x2000 or ch=='₹']
    t=" ".join("".join(keep).split())
    for p in [" ?"," ."," ,"," :"," !"]:
        t=t.replace(p,p.strip())
    return t.strip()

def opts4(correct,distractors):
    o=[]
    for d in [correct]+list(distractors):
        s=str(d)
        if s not in o: o.append(s)
        if len(o)==4: break
    i=1
    while len(o)<4:
        cand=str(correct+i) if isinstance(correct,int) else str(correct)+"·"*i
        if cand not in o: o.append(cand)
        i+=1
    random.shuffle(o)
    return o

def mk(bucket,seen,q,correct,distractors,expl,plain=None):
    if q in seen: return
    op=opts4(correct,distractors)
    if str(correct) not in op or len(set(op))!=4: return
    seen.add(q)
    bucket.append({"question":q,"questionPlain":plain if plain else plainify(q),
                   "options":op,"answer":str(correct),"explanation":expl})

def clockd(ch):  # 3 distinct clock-hour distractors, 1..12, != ch
    out=[]
    for x in [ch-1,ch+1,ch-2,ch+2,ch-3,ch+3]:
        if 1<=x<=12 and x!=ch:
            s=f"{x} o'clock"
            if s not in out: out.append(s)
        if len(out)==3: break
    return out

def rdist(v):  # 3 distinct rupee distractors, != v, >=0
    out=[]
    for x in [v+1,v-1,v+2,v-2,v+3]:
        if x>=0 and x!=v:
            s=f"₹{x}"
            if s not in out: out.append(s)
        if len(out)==3: break
    return out

# =========================================================
# CHAPTER GENERATORS
# =========================================================
def gen_numbers(lo,hi,seen):
    b=[]
    def ndist(n):  # 3 distinct number-name distractors within range
        out=[]
        for x in [n-1,n+1,n-2,n+2,n-3,n+3]:
            if 1<=x<=hi and x!=n:
                v=nm(x)
                if v not in out: out.append(v)
            if len(out)==3: break
        return out
    def idist(n):  # 3 distinct numeric distractors != n
        out=[]
        for x in [n+1,n-1,n+2,n-2,n+3]:
            if x!=n and x not in out: out.append(x)
            if len(out)==3: break
        return out
    for n in range(max(1,lo),hi+1):
        mk(b,seen,f"🔢 What is the number name of {n}?",nm(n),ndist(n),f"{n} is read as {nm(n)}.")
        mk(b,seen,f"✍️ Which number is written as '{nm(n)}'?",n,idist(n),f"'{nm(n)}' is the number {n}.")
    for n in range(lo,hi):
        mk(b,seen,f"🐣 Which number comes right after {n}?",n+1,[n-1 if n>0 else n+2,n,n+2],f"After {n} comes {n+1}.")
    for n in range(max(1,lo),hi+1):
        mk(b,seen,f"⬅️ Which number comes just before {n}?",n-1,[n+1,n,n-2 if n>1 else n+2],f"Before {n} comes {n-1}.")
    for n in range(max(1,lo),hi-1):
        mk(b,seen,f"🌉 Which number sits between {n} and {n+2}?",n+1,[n,n+2,n+3],f"{n+1} is between {n} and {n+2}.")
    for n in range(10,hi+1):
        mk(b,seen,f"🏠 In {n}, which digit is in the TENS place?",n//10,[n%10,n,0],f"In {n}, tens digit = {n//10}.")
        mk(b,seen,f"🏠 In {n}, which digit is in the ONES place?",n%10,[n//10,n,(n%10+1)%10],f"In {n}, ones digit = {n%10}.")
    for t in range(1,hi//10+1):
        for o in range(0,10):
            v=t*10+o
            if lo<=v<=hi:
                mk(b,seen,f"🧱 {t} tens and {o} ones make which number?",v,[o*10+t if o!=t else v+2,min(hi,v+10),v-1 if v>0 else v+3],f"{t} tens + {o} ones = {v}.")
    for n in range(lo,hi):
        mk(b,seen,f"➡️ Which number is 1 MORE than {n}?",n+1,[n-1 if n>0 else n+2,n,n+2],f"1 more than {n} is {n+1}.")
    for n in range(max(1,lo),hi+1):
        mk(b,seen,f"⬇️ Which number is 1 LESS than {n}?",n-1,[n+1,n,n-2 if n>1 else n+2],f"1 less than {n} is {n-1}.")
    for n in range(lo,hi-9):
        mk(b,seen,f"🚀 Which number is 10 MORE than {n}?",n+10,[n-10 if n>=10 else n+20,n,n+9],f"10 more than {n} is {n+10}.")
    for n in range(max(10,lo),hi+1):
        mk(b,seen,f"🪂 Which number is 10 LESS than {n}?",n-10,[min(hi,n+10),n,n-9],f"10 less than {n} is {n-10}.")
    for step,em in [(2,"🐇"),(5,"🖐️"),(10,"🔟")]:
        for start in range(0,hi):
            a,bb,c,nx=start,start+step,start+2*step,start+3*step
            if nx<=hi and a>=lo:
                mk(b,seen,f"{em} Skip count by {step}s: {a}, {bb}, {c}, __?",nx,[nx+1,nx-1,c],f"Adding {step} each time, next is {nx}.")
    used=set(); tries=0; cap=1100 if hi>60 else 850
    while len(used)<cap and tries<9000:
        tries+=1
        nums=tuple(sorted(random.sample(range(max(1,lo),hi+1),4)))
        if nums in used: continue
        used.add(nums)
        disp=list(nums); random.shuffle(disp); qs=", ".join(map(str,disp))
        mk(b,seen,f"🏆 Which is the GREATEST? {qs}",max(nums),[x for x in nums if x!=max(nums)],f"{max(nums)} is the greatest.")
        mk(b,seen,f"🐜 Which is the SMALLEST? {qs}",min(nums),[x for x in nums if x!=min(nums)],f"{min(nums)} is the smallest.")
    # ordering (ascending/descending) with 3-number sets
    used2=set(); tries=0; cap2=500 if hi>60 else 350
    while len(used2)<cap2 and tries<6000:
        tries+=1
        nums=tuple(sorted(random.sample(range(max(1,lo),hi+1),3)))
        if nums in used2: continue
        used2.add(nums)
        disp=list(nums); random.shuffle(disp); qs=", ".join(map(str,disp))
        mk(b,seen,f"📈 Arranged smallest → greatest, which comes FIRST? {qs}",min(nums),[x for x in nums if x!=min(nums)],f"Ascending order starts with {min(nums)}.")
        mk(b,seen,f"📉 Arranged greatest → smallest, which comes FIRST? {qs}",max(nums),[x for x in nums if x!=max(nums)],f"Descending order starts with {max(nums)}.")
        mk(b,seen,f"🔢 In ascending order, which number comes in the MIDDLE? {qs}",nums[1],[nums[0],nums[2],nums[1]+1 if nums[1]+1!=nums[2] else nums[1]-1],f"Sorted: {', '.join(map(str,nums))}; middle is {nums[1]}.")
    # compare two numbers
    used3=set(); tries=0; cap3=400 if hi>60 else 300
    while len(used3)<cap3 and tries<5000:
        tries+=1
        a,c=random.sample(range(max(1,lo),hi+1),2)
        key=tuple(sorted((a,c)))
        if key in used3: continue
        used3.add(key)
        mk(b,seen,f"🔍 Which is SMALLER: {a} or {c}?",min(a,c),[max(a,c),abs(a-c),max(a,c)+1],f"{min(a,c)} is smaller than {max(a,c)}.")
        mk(b,seen,f"🔎 Which is GREATER: {a} or {c}?",max(a,c),[min(a,c),abs(a-c),min(a,c)-1 if min(a,c)>1 else min(a,c)+2],f"{max(a,c)} is greater than {min(a,c)}.")
    for n in range(max(3,lo),min(hi,16)):
        it,em=rot(ITEMS,n)
        mk(b,seen,f"🧮 Count them: {em*n} = ?",n,[n+1,n-1,n+2],f"There are {n} {it}.",
           plain=f"Count the {it} shown in the picture. How many are there?")
    return b

def gen_add20(seen):
    b=[]; facts=[(a,c) for a in range(0,11) for c in range(a,21) if a+c<=20]; ai=0
    for (a,c) in facts:
        s=a+c
        mk(b,seen,f"🔢 {a} + {c} = ?",s,[s+1,s-1 if s>0 else s+2,max(a,c)],f"{a} plus {c} equals {s}.")
        if 1<=a<=9 and 1<=c<=9:
            it,em=rot(ITEMS,ai)
            mk(b,seen,f"🧮 {em*a} + {em*c} = ? {it}",s,[s+1,s-1,a],f"{a} {it} and {c} {it} make {s}.",
               plain=f"Add the two groups: {a} {it} and {c} {it}. How many {it} in all?")
        mk(b,seen,f"🧩 Fill the blank: {a} + __ = {s}",c,[c+1,c-1 if c>0 else c+2,s],f"{a} + {c} = {s}.")
        if a!=c: mk(b,seen,f"🧩 Fill the blank: __ + {c} = {s}",a,[a+1,a-1 if a>0 else a+2,s],f"{a} + {c} = {s}.")
        ai+=1
    for a in range(1,11): mk(b,seen,f"👯 Double of {a}: {a} + {a} = ?",2*a,[2*a+1,2*a-1,a],f"{a} + {a} = {2*a}.")
    mk(b,seen,"➕ Which sign tells us to ADD?","+",["-","=","×"],"The plus sign (+) means add.")
    tmpl=["🎈 {n} had {a} {it} and got {b} more. How many {it} in all?",
          "🧺 {n} put {a} {it} in a basket, then added {b} more. How many {it} now?",
          "🎁 {n} had {a} {it} and grandma gave {b} more. How many {it}?",
          "🛒 {n} bought {a} {it} and {b} more {it}. How many {it} altogether?"]
    si=0
    for (a,c) in facts:
        if a==0 or c==0: continue
        for r in range(2 if a+c<=12 else 3):
            n=rot(NAMES,si); it,em=rot(ITEMS,si); t=rot(tmpl,si)
            mk(b,seen,t.format(n=n,a=a,b=c,it=it),a+c,[a+c+1,a+c-1,abs(a-c) if abs(a-c)!=a+c else a],f"{a} + {c} = {a+c} {it}.")
            si+=1
    tri=set()
    for _ in range(800):
        a,c,d=[random.randint(1,8) for _ in range(3)]
        if a+c+d<=20 and (a,c,d) not in tri:
            tri.add((a,c,d)); mk(b,seen,f"🧮 {a} + {c} + {d} = ?",a+c+d,[a+c+d+1,a+c+d-1,a+c],f"{a}+{c}+{d} = {a+c+d}.")
    return b

def gen_sub20(seen):
    b=[]; facts=[(a,c) for a in range(0,21) for c in range(0,a+1)]; di=0
    for (a,c) in facts:
        d=a-c
        mk(b,seen,f"🔢 {a} - {c} = ?",d,[d+1,d-1 if d>0 else d+2,a if a!=d else c+1],f"{a} take away {c} equals {d}.")
        if 1<=a<=10 and 1<=c<a:
            it,em=rot(ITEMS,di)
            mk(b,seen,f"🧮 {a} {it}, take away {c}: {em*a} ➡️ {'❌'*c+em*(a-c)} = ?",d,[d+1,d-1,a],f"{a} - {c} = {d} {it} left.",
               plain=f"Start with {a} {it} and take away {c}. How many {it} are left?")
        mk(b,seen,f"🧩 Fill the blank: {a} - __ = {d}",c,[c+1,c-1 if c>0 else c+2,a],f"{a} - {c} = {d}.")
        di+=1
    for c in range(0,20):
        for d in range(0,21-c):
            x=c+d
            if x<=20: mk(b,seen,f"🧩 Fill the blank: __ - {c} = {d}",x,[x+1,x-1 if x>0 else x+2,d],f"{x} - {c} = {d}.")
    for a in range(1,21):
        mk(b,seen,f"🗑️ {a} - {a} = ? (take away all)",0,[a,1,a-1],"Taking away all leaves 0.")
        mk(b,seen,f"🎯 {a} - 0 = ? (take away none)",a,[0,a-1,a+1],f"Taking away nothing leaves {a}.")
    mk(b,seen,"➖ Which sign tells us to SUBTRACT?","-",["+","=","×"],"The minus sign (-) means take away.")
    tmpl=["🍪 There were {a} {it}. {n} ate {b}. How many {it} left?",
          "🎈 {n} had {a} {it} but {b} flew away. How many {it} left?",
          "🧺 A basket had {a} {it}. {n} took out {b}. How many {it} remain?",
          "👐 {n} had {a} {it} and gave {b} away. How many {it} left?"]
    ki=0
    for (a,c) in facts:
        if a==0 or c==0 or c==a: continue
        for r in range(2 if a<=12 else 3):
            n=rot(NAMES,ki); it,em=rot(ITEMS,ki); t=rot(tmpl,ki)
            mk(b,seen,t.format(n=n,a=a,b=c,it=it),a-c,[a-c+1,a-c-1 if a-c>0 else a-c+2,a],f"{a} - {c} = {a-c} {it} left.")
            ki+=1
    return b

def gen_shapes(seen):
    b=[]
    shapes={"Circle":("round with no corners",0),"Triangle":("3 sides and 3 corners",3),
            "Square":("4 equal sides and 4 corners",4),"Rectangle":("4 sides with 2 long and 2 short",4)}
    names=list(shapes)
    for s,(desc,sides) in shapes.items():
        others=[x for x in names if x!=s]
        mk(b,seen,f"🔷 Which shape is {desc}?",s,others,f"A {s.lower()} is {desc}.")
    mk(b,seen,"🔺 How many sides does a triangle have?",3,[4,2,5],"A triangle has 3 sides.")
    mk(b,seen,"🟥 How many sides does a square have?",4,[3,5,2],"A square has 4 sides.")
    mk(b,seen,"🔵 How many corners does a circle have?",0,[1,2,4],"A circle has no corners.")
    mk(b,seen,"📐 How many corners does a triangle have?",3,[4,2,0],"A triangle has 3 corners.")
    mk(b,seen,"📐 How many corners does a rectangle have?",4,[3,2,5],"A rectangle has 4 corners.")
    real=[("ball","Circle"),("plate","Circle"),("clock","Circle"),("coin","Circle"),("wheel","Circle"),
          ("slice of pizza","Triangle"),("roof of a hut","Triangle"),("party hat","Triangle"),("samosa","Triangle"),
          ("window","Square"),("chess board","Square"),("carrom board","Square"),("napkin","Square"),
          ("door","Rectangle"),("book cover","Rectangle"),("brick","Rectangle"),("mobile phone","Rectangle"),("chocolate bar","Rectangle")]
    for obj,sh in real:
        mk(b,seen,f"🔷 Which shape is a {obj} most like?",sh,[x for x in names if x!=sh],f"A {obj} looks like a {sh.lower()}.")
    for i,(obj,sh) in enumerate(real):
        n=rot(NAMES,i)
        mk(b,seen,f"🔎 {n} looks at a {obj}. Which shape is it like?",sh,[x for x in names if x!=sh],f"A {obj} is like a {sh.lower()}.")
    POOL=["Red","Blue","Yellow","Green","Star","Heart","Circle","Square","Apple","Banana","Up","Down","Big","Small"]
    patterns=[["Red","Blue"],["Red","Blue","Yellow"],["Star","Heart"],["Circle","Square"],
              ["Big","Small"],["Red","Red","Blue"],["Apple","Banana"],["Up","Down"],
              ["Green","Yellow"],["Heart","Heart","Star"],["Circle","Circle","Square"],["Red","Green","Blue"]]
    for pat in patterns:
        full=pat*6; seq=full[:6]; nxt=full[6]
        dis=[x for x in pat if x!=nxt]+[x for x in POOL if x not in pat]
        mk(b,seen,f"🎨 What comes next in the pattern: {', '.join(seq)}, __?",nxt,dis,
           f"The pattern repeats '{'-'.join(pat)}', so next comes {nxt}.")
        # longer, shifted start for more unique items
        seq2=full[1:7]; nxt2=full[7]
        mk(b,seen,f"🎨 Continue the pattern: {', '.join(seq2)}, __?",nxt2,[x for x in pat if x!=nxt2]+[x for x in POOL if x not in pat],
           f"The pattern repeats '{'-'.join(pat)}', so next comes {nxt2}.")
    bigpairs=[("elephant","ant"),("bus","cycle"),("tree","flower"),("mountain","hill"),
              ("whale","fish"),("lion","cat"),("cow","goat"),("house","hut")]
    for i,(big,small) in enumerate(bigpairs):
        mk(b,seen,f"🔍 Which is BIGGER: an {big} or an {small}?" if big[0] in "aeiou" else f"🔍 Which is BIGGER: a {big} or a {small}?",
           big.capitalize(),[small.capitalize(),"Both same","Cannot say"],f"A {big} is bigger than a {small}.")
        mk(b,seen,f"🔍 Which is SMALLER: a {big} or a {small}?",small.capitalize(),[big.capitalize(),"Both same","Cannot say"],f"A {small} is smaller than a {big}.")
    return b

def gen_add_greater(seen):
    b=[]
    for n in range(1,100):
        mk(b,seen,f"➕ Which number is 1 MORE than {n}?",n+1,[n-1,n,n+2],f"1 more than {n} is {n+1}.")
        mk(b,seen,f"🐣 What is the number after {n}?",n+1,[n-1,n,n+2],f"After {n} comes {n+1}.")
        mk(b,seen,f"🔢 {n} + 1 = ?",n+1,[n,n+2,n-1],f"{n} + 1 = {n+1}.")
    for t in range(1,10):
        for o in range(0,9):
            for k in range(1,9-o+1):
                a=t*10+o
                if a+k<100:
                    mk(b,seen,f"🔢 {a} + {k} = ?",a+k,[a+k+1,a+k-1,a],f"{a} + {k} = {a+k}.")
    for t1 in range(1,9):
        for t2 in range(1,10-t1):
            mk(b,seen,f"🔟 {t1*10} + {t2*10} = ?",(t1+t2)*10,[(t1+t2)*10+10,(t1+t2)*10-10,(t1+t2)],f"{t1*10} + {t2*10} = {(t1+t2)*10}.")
    si=0
    for _ in range(1200):
        a=random.randint(11,90)
        if a%10<9:
            k=random.randint(1,9-(a%10))
            if a+k<100:
                n=rot(NAMES,si); it,em=rot(ITEMS,si)
                mk(b,seen,f"{em} {n} had {a} {it} and got {k} more. How many {it} now?",a+k,[a+k+1,a+k-1,a],f"{a} + {k} = {a+k} {it}.")
                si+=1
    return b

def gen_sub_greater(seen):
    b=[]
    for n in range(2,100):
        mk(b,seen,f"➖ Which number is 1 LESS than {n}?",n-1,[n+1,n,n-2],f"1 less than {n} is {n-1}.")
        mk(b,seen,f"⬅️ What is the number before {n}?",n-1,[n+1,n,n-2],f"Before {n} comes {n-1}.")
        mk(b,seen,f"🔢 {n} - 1 = ?",n-1,[n,n-2,n+1],f"{n} - 1 = {n-1}.")
    for t in range(1,10):
        for o in range(1,10):
            for k in range(1,o+1):
                a=t*10+o
                mk(b,seen,f"🔢 {a} - {k} = ?",a-k,[a-k+1,a-k-1,a],f"{a} - {k} = {a-k}.")
    for t1 in range(2,10):
        for t2 in range(1,t1):
            mk(b,seen,f"🔟 {t1*10} - {t2*10} = ?",(t1-t2)*10,[(t1-t2)*10+10,(t1-t2)*10-10 if t1-t2>1 else (t1-t2)*10+20,(t1-t2)],f"{t1*10} - {t2*10} = {(t1-t2)*10}.")
    si=0
    for _ in range(1200):
        t=random.randint(2,9); o=random.randint(1,9); a=t*10+o; k=random.randint(1,o)
        n=rot(NAMES,si); it,em=rot(ITEMS,si)
        mk(b,seen,f"{em} {n} had {a} {it} and gave {k} away. How many {it} left?",a-k,[a-k+1,a-k-1,a],f"{a} - {k} = {a-k} {it} left.")
        si+=1
    return b

def gen_measurement(seen):
    b=[]
    # each pair is (bigger, smaller) — hand-checked so the answer is always clear
    taller=[("a tree","a flower"),("a building","a car"),("a giraffe","a dog"),("a man","a baby"),
            ("a palm tree","a mushroom"),("a tower","a hut"),("a ladder","a stool"),("a horse","a rabbit"),
            ("an elephant","an ant"),("a lamp post","a bench"),("a mountain","a hill"),("a coconut tree","a bush"),
            ("a lighthouse","a boat"),("a bus","a bicycle"),("a father","a child"),("a door","a shoe"),
            ("a chimney","a chair"),("a flag pole","a football"),("a camel","a goat"),("a cupboard","a lunchbox"),
            ("a streetlight","a puppy"),("a windmill","a kite"),("a crane","a truck"),("a coconut palm","a rose plant"),
            ("a two-storey house","a scooter")]
    heavier=[("an elephant","an ant"),("a bus","a bicycle"),("a rock","a feather"),("a watermelon","a cherry"),
             ("a bag of books","a pencil"),("a cow","a goat"),("a truck","a scooter"),("a brick","a balloon"),
             ("an almirah","a spoon"),("a sack of rice","an apple"),("a fridge","a mobile phone"),("a car","a football"),
             ("a horse","a cat"),("a table","a leaf"),("a suitcase","a hanky"),("a drum of water","a cup"),
             ("a sofa","a cushion"),("a tractor","a tricycle"),("a buffalo","a hen"),("a cement bag","a sheet of paper"),
             ("a television","a remote"),("a gas cylinder","a matchbox"),("a wooden log","a twig"),
             ("a motorbike","a helmet"),("a bag of potatoes","a chip")]
    longer=[("a train","a pencil"),("a snake","a worm"),("a road","a ladder"),("a scarf","a ribbon"),
            ("a bus","a pen"),("a river","a stream"),("a rope","a thread"),("a bridge","a plank"),
            ("a cricket bat","a matchstick"),("a python","an earthworm"),("a highway","a footpath"),
            ("a garden hose","a straw"),("a railway track","a shoelace"),("a sari","a napkin"),
            ("a fishing rod","a spoon"),("a broomstick","a crayon"),("a slide","a step"),
            ("a ship","a canoe"),("a measuring tape","a nail"),("a corridor","a doormat"),
            ("a sugarcane","a chilli"),("a belt","a coin"),("a bench","a brick"),("a ladder","a book"),("a hockey stick","a bindi")]
    holds=[("a bucket","a cup"),("a drum","a bottle"),("a swimming pool","a bathtub"),("a teapot","a spoon"),
           ("a water tank","a jug"),("a barrel","a glass"),("a pitcher","a katori"),("a lake","a pond"),
           ("a tanker","a bucket"),("a big pot","a small bowl"),("a jerrycan","a mug"),
           ("a bathtub","a flask"),("a matka","a tumbler"),("a well","a bucket"),
           ("a jug","a thimble"),("a cooler","a bottle"),("a fish tank","a glass"),
           ("a milk can","a katori"),("a rain barrel","a cup"),("a tub","a spoon"),
           ("an aquarium","a bowl"),("a pond","a puddle"),("a kettle","a ladle"),("a bathtub","a coffee cup"),("a bucket","a matchbox")]
    CN=NAMES[:10]
    def blk(pairs,MORE,LESS,unit,scenes,ask_more):
        for big,small in pairs:
            mk(b,seen,f"{scenes[0]} Which is {MORE}: {big} or {small}?",big.capitalize(),[small.capitalize(),f"Same {unit}","Cannot say"],f"{big.capitalize()} is {MORE.lower()} than {small}.")
            mk(b,seen,f"{scenes[0]} Which is {LESS}: {big} or {small}?",small.capitalize(),[big.capitalize(),f"Same {unit}","Cannot say"],f"{small.capitalize()} is {LESS.lower()} than {big}.")
            for j,n in enumerate(CN):
                tmpl=scenes[1+(j%(len(scenes)-1))]
                mk(b,seen,tmpl.format(n=n,big=big,small=small),big.capitalize(),[small.capitalize(),f"Same {unit}","Cannot say"],ask_more.format(big=big.capitalize(),small=small))
    blk(taller,"TALLER","SHORTER","height",
        ["📏","📏 {n} places {big} next to {small}.","📏 {n} sees {big} and {small} in a park.","📏 In {n}'s drawing, {big} stands beside {small}.","📏 {n} compares {big} with {small}."],
        "{big} is taller than {small}.")
    blk(heavier,"HEAVIER","LIGHTER","weight",
        ["⚖️","⚖️ {n} lifts {big} and {small}.","⚖️ {n} puts {big} and {small} on a seesaw.","⚖️ {n} weighs {big} against {small}.","⚖️ {n} carries {big} and {small}."],
        "{big} is heavier than {small}.")
    blk(longer,"LONGER","SHORTER","length",
        ["📐","📐 {n} lays {big} beside {small}.","📐 {n} measures {big} and {small}.","📐 {n} lines up {big} next to {small}.","📐 {n} compares the length of {big} and {small}."],
        "{big} is longer than {small}.")
    for big,small in holds:
        mk(b,seen,f"💧 Which holds MORE water: {big} or {small}?",big.capitalize(),[small.capitalize(),"Same","Cannot say"],f"{big.capitalize()} holds more water than {small}.")
        mk(b,seen,f"💧 Which holds LESS water: {big} or {small}?",small.capitalize(),[big.capitalize(),"Same","Cannot say"],f"{small.capitalize()} holds less water than {big}.")
        for j,n in enumerate(CN):
            scenes=["💧 {n} fills {big} and {small} with water. Which holds more?",
                    "💧 {n} pours water into {big} and {small}. Which holds more?",
                    "💧 {n} compares how much {big} and {small} can hold. Which holds more?"]
            mk(b,seen,scenes[j%len(scenes)].format(n=n,big=big,small=small),big.capitalize(),[small.capitalize(),"Same","Cannot say"],f"{big.capitalize()} holds more water than {small}.")
    mk(b,seen,"🖐️ We can measure a table's length using ____.","handspans",["kilograms","litres","hours"],"Handspans, footspans and paces measure length.")
    mk(b,seen,"👣 We can measure the floor by counting ____.","footspans",["cups","clocks","coins"],"Footspans measure long lengths.")
    mk(b,seen,"🦶 Steps we take to measure a long corridor are called ____.","paces",["litres","grams","hours"],"Paces measure long lengths.")
    return b

def gen_time(seen):
    b=[]
    DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
    mk(b,seen,"🌞 When do we see the Sun brightly?","Day",["Night","Never","Midnight"],"We see the Sun in the day.")
    mk(b,seen,"🌙 When do we see the Moon and stars?","Night",["Day","Noon","Morning"],"We see the Moon at night.")
    mk(b,seen,"🍳 We eat breakfast in the ____.","Morning",["Night","Evening","Midnight"],"Breakfast is a morning meal.")
    mk(b,seen,"🛌 We go to sleep at ____.","Night",["Morning","Noon","Afternoon"],"We sleep at night.")
    mk(b,seen,"🌅 The Sun rises in the ____.","Morning",["Night","Midnight","Evening"],"The Sun rises in the morning.")
    for i,dname in enumerate(DAYS):
        after=DAYS[(i+1)%7]; before=DAYS[(i-1)%7]
        others=[d for d in DAYS if d not in (after,before,dname)]
        mk(b,seen,f"📅 Which day comes AFTER {dname}?",after,[before]+others[:2],f"After {dname} comes {after}.")
        mk(b,seen,f"📅 Which day comes BEFORE {dname}?",before,[after]+others[:2],f"Before {dname} comes {before}.")
    mk(b,seen,"🗓️ How many days are there in a week?",7,[5,6,8],"A week has 7 days.")
    mk(b,seen,"🎉 Which two days make the weekend?","Saturday and Sunday",["Monday and Tuesday","Friday and Monday","Wednesday and Thursday"],"Saturday and Sunday are the weekend.")
    mk(b,seen,"📆 How many months are there in a year?",12,[10,11,7],"A year has 12 months.")
    mk(b,seen,"🕛 What is another name for the long hand of a clock?","Minute hand",["Hour hand","Second hand","Big hand only"],"The long hand is the minute hand.")
    # 2 days after/before
    for i,dname in enumerate(DAYS):
        d2a=DAYS[(i+2)%7]; d2b=DAYS[(i-2)%7]
        mk(b,seen,f"📅 Which day comes 2 days AFTER {dname}?",d2a,[d for d in DAYS if d!=d2a][:3],f"Two days after {dname} is {d2a}.")
        mk(b,seen,f"📅 Which day comes 2 days BEFORE {dname}?",d2b,[d for d in DAYS if d!=d2b][:3],f"Two days before {dname} is {d2b}.")
    # o'clock, base: 1/2/3 hours after and before
    for L in (1,2,3):
        for h in range(1,13-L):
            mk(b,seen,f"🕐 What time is {L} hour{'s' if L>1 else ''} AFTER {h} o'clock?",f"{h+L} o'clock",
               clockd(h+L),f"{L} hour(s) after {h} o'clock is {h+L} o'clock.")
        for h in range(1+L,13):
            mk(b,seen,f"🕐 What time is {L} hour{'s' if L>1 else ''} BEFORE {h} o'clock?",f"{h-L} o'clock",
               clockd(h-L),f"{L} hour(s) before {h} o'clock is {h-L} o'clock.")
    slow=["sleeping at night","reading a whole book","growing a plant","a full school day","a long train journey","painting a big wall","a summer holiday","cooking a meal"]
    fast=["blinking your eye","clapping once","a single jump","snapping fingers","tying a shoelace","switching on a light","opening a door","sneezing once"]
    for i in range(len(slow)):
        mk(b,seen,f"⏳ Which takes MORE time: {slow[i]} or {fast[i]}?",slow[i].capitalize(),[fast[i].capitalize(),"Same","Cannot say"],f"{slow[i].capitalize()} takes more time.")
        mk(b,seen,f"⏳ Which takes LESS time: {slow[i]} or {fast[i]}?",fast[i].capitalize(),[slow[i].capitalize(),"Same","Cannot say"],f"{fast[i].capitalize()} takes less time.")
    # character-context clock questions (1 & 2 hours later) for volume
    CN=NAMES
    EVT=[("school","starts"),("class","begins"),("party","starts"),("cricket match","begins"),
         ("movie","starts"),("dance class","begins"),("train","leaves"),("bus","leaves"),
         ("music lesson","starts"),("swimming class","begins"),("picnic","starts"),("cartoon show","begins")]
    ei=0
    for h in range(1,12):
        for n in CN:
            place,verb=rot(EVT,ei); ei+=1
            mk(b,seen,f"🕐 {n}'s {place} {verb} at {h} o'clock. What time is 1 hour later?",f"{h+1} o'clock",
               clockd(h+1),f"One hour after {h} o'clock is {h+1} o'clock.")
    for h in range(2,13):
        for n in CN:
            place,verb=rot(EVT,ei); ei+=1
            mk(b,seen,f"🕐 {n}'s {place} {verb} at {h} o'clock. What time was it 1 hour earlier?",f"{h-1} o'clock",
               clockd(h-1),f"One hour before {h} o'clock is {h-1} o'clock.")
    # day-context after/before
    ACT=["holiday","birthday","exam","trip","match","function","visit to grandma","library day"]
    for i,dname in enumerate(DAYS):
        after=DAYS[(i+1)%7]; before=DAYS[(i-1)%7]
        for j,n in enumerate(NAMES[:20]):
            act=rot(ACT,i+j)
            mk(b,seen,f"📅 {n}'s {act} is on {dname}. Which day comes just after?",after,[before]+[d for d in DAYS if d not in (after,before,dname)][:2],f"After {dname} comes {after}.")
            mk(b,seen,f"📅 {n}'s {act} is on {dname}. Which day comes just before?",before,[after]+[d for d in DAYS if d not in (after,before,dname)][:2],f"Before {dname} comes {before}.")
    return b

def gen_money(seen):
    b=[]
    mk(b,seen,"💰 The symbol ₹ stands for ____.","Rupee",["Paise","Dollar","Litre"],"₹ stands for rupee.")
    mk(b,seen,"🪙 The letter 'p' after a coin value stands for ____.","Paise",["Rupee","Pound","Point"],"'p' stands for paise.")
    mk(b,seen,"🔁 1 rupee = ____ paise.",100,[10,50,1000],"1 rupee = 100 paise.")
    mk(b,seen,"🪙 The value side of a coin is called ____.","Tails",["Heads","Side","Edge"],"The value side is called tails.")
    mk(b,seen,"🪙 The other side of a coin is called ____.","Heads",["Tails","Back","Top"],"The other side is called heads.")
    coins=[1,2,5,10,20]
    for a in coins:
        for c in coins:
            if a>c:
                mk(b,seen,f"💵 Which has MORE value: ₹{a} or ₹{c}?",f"₹{a}",[f"₹{c}","Same","Cannot say"],f"₹{a} is more than ₹{c}.")
                mk(b,seen,f"💵 Which has LESS value: ₹{a} or ₹{c}?",f"₹{c}",[f"₹{a}","Same","Cannot say"],f"₹{c} is less than ₹{a}.")
    for a in coins:
        for c in coins:
            if a+c<=50:
                mk(b,seen,f"🪙 ₹{a} + ₹{c} = ?",f"₹{a+c}",rdist(a+c),f"₹{a} + ₹{c} = ₹{a+c}.")
    for note in [1,2,5,10,20,50]:
        for k in range(2,6):
            mk(b,seen,f"💶 {k} coins of ₹{note} together make ____.",f"₹{note*k}",rdist(note*k),f"{k} × ₹{note} = ₹{note*k}.")
    costs=[("pencil",9),("eraser",5),("sharpener",7),("candy",2),("notebook",20),("pen",10),
           ("ruler",8),("toffee",1),("chocolate",15),("balloon",3),("biscuit",4),("marble",6),
           ("sticker",2),("crayon",7),("kite",12),("cupcake",18)]
    for i in range(len(costs)):
        for j in range(i+1,len(costs)):
            (n1,c1),(n2,c2)=costs[i],costs[j]
            if c1==c2: continue
            more=n1 if c1>c2 else n2; less=n2 if c1>c2 else n1
            mk(b,seen,f"🛒 A {n1} costs ₹{c1} and a {n2} costs ₹{c2}. Which costs MORE?",more.capitalize(),[less.capitalize(),"Same","Cannot say"],f"₹{max(c1,c2)} > ₹{min(c1,c2)}.")
            mk(b,seen,f"🛒 A {n1} costs ₹{c1} and a {n2} costs ₹{c2}. Which costs LESS?",less.capitalize(),[more.capitalize(),"Same","Cannot say"],f"₹{min(c1,c2)} < ₹{max(c1,c2)}.")
            mk(b,seen,f"🧮 A {n1} costs ₹{c1} and a {n2} costs ₹{c2}. How much MORE does the costlier one cost?",f"₹{abs(c1-c2)}",rdist(abs(c1-c2)),f"₹{max(c1,c2)} - ₹{min(c1,c2)} = ₹{abs(c1-c2)}.")
    # character-context shopping totals
    CN=NAMES
    for a in coins:
        for c in coins:
            if a+c<=50:
                for n in CN:
                    mk(b,seen,f"🛍️ {n} buys one thing for ₹{a} and another for ₹{c}. How much in total?",f"₹{a+c}",
                       rdist(a+c),f"₹{a} + ₹{c} = ₹{a+c}.")
    # change-making (simple subtraction)
    NOTES=[5,10,20,50]
    ci=0
    for item,price in costs:
        for note in NOTES:
            if note>price:
                ch=note-price
                for n in NAMES[:8]:
                    mk(b,seen,f"💳 {n} buys a {item} for ₹{price} and pays with a ₹{note} note. How much change?",f"₹{ch}",
                       rdist(ch),f"₹{note} - ₹{price} = ₹{ch}.")
                    ci+=1
    return b

def gen_data(seen):
    b=[]
    for it,em in ITEMS:
        for k in range(2,11):
            mk(b,seen,f"📊 Count the {it}: {em*k} — how many?",k,[k+1,k-1,k+2],f"There are {k} {it}.",
               plain=f"Count the {it} shown in the picture. How many {it} are there?")
    combos=set()
    for _ in range(1500):
        it,em=rot(ITEMS,random.randint(0,999)); a,c=random.sample(range(1,10),2)
        n1,n2=random.sample(NAMES,2)
        key=(it,a,c,n1,n2)
        if key in combos: continue
        combos.add(key)
        more=n1 if a>c else n2; fewer=n2 if a>c else n1
        mk(b,seen,f"📈 Who has MORE {it}? {n1}: {em*a}  |  {n2}: {em*c}",more,[fewer,"Both same","Cannot say"],f"{max(a,c)} is more than {min(a,c)}.",
           plain=f"{n1} has {a} {it} and {n2} has {c} {it}. Who has more {it}?")
        mk(b,seen,f"📉 Who has FEWER {it}? {n1}: {em*a}  |  {n2}: {em*c}",fewer,[more,"Both same","Cannot say"],f"{min(a,c)} is fewer than {max(a,c)}.",
           plain=f"{n1} has {a} {it} and {n2} has {c} {it}. Who has fewer {it}?")
    return b

def gen_mult_ready(seen):
    b=[]
    for g in range(2,7):
        for e in range(2,7):
            it,em=rot(ITEMS,g*e+e); groups="  ".join([em*e]*g)
            mk(b,seen,f"🍎 How many GROUPS are there? {groups}",g,[g+1,g-1,e],f"There are {g} groups.",
               plain=f"There are some equal groups of {it}, with {e} {it} in each group, and {g} groups in total. How many groups are there?")
            mk(b,seen,f"🍎 How many {it} in EACH group? {groups}",e,[e+1,e-1,g],f"Each group has {e} {it}.",
               plain=f"There are {g} equal groups of {it} with {e} in each. How many {it} are in each group?")
            mk(b,seen,f"🧮 {g} groups of {e} — how many in all? {groups}",g*e,[g*e+1,g*e-1,g+e],f"{g} groups of {e} = {g*e} in all.",
               plain=f"There are {g} groups of {e} {it}. How many {it} are there in all?")
    # repeated-addition readiness (single concept)
    for g in range(2,6):
        for e in range(2,6):
            terms=" + ".join([str(e)]*g)
            mk(b,seen,f"➕ {terms} ({g} groups of {e}) = ?",g*e,[g*e+1,g*e-1,g+e],f"Adding {e}, {g} times = {g*e}.")
    # skip-count-to-total (equal groups)
    for e in (2,5,10):
        for g in range(2,7):
            seq=", ".join(str(e*k) for k in range(1,g+1))
            mk(b,seen,f"🔢 Count in {e}s: {seq}. This is {g} groups of {e}. How many in all?",g*e,[g*e+1,g*e-1,g+e],f"{g} groups of {e} = {g*e}.")
    # character-context equal-group word problems (two templates) for volume
    CN=NAMES
    T=["🧺 {n} makes {g} equal groups with {e} {it} in each. How many {it} in all?",
       "🎒 {n} packs {g} bags with {e} {it} in each bag. How many {it} altogether?"]
    ti=0
    for g in range(2,7):
        for e in range(2,7):
            for n in CN:
                it,em=rot(ITEMS,g+e+ti)
                for t in T:
                    mk(b,seen,t.format(n=n,g=g,e=e,it=it),g*e,[g*e+1,g*e-1,g+e],f"{g} groups of {e} = {g*e} {it}.")
                ti+=1
    return b

# =========================================================
# BUILD POOLS
# =========================================================
seen=set()
pools={
 1:gen_numbers(1,50,seen), 2:gen_add20(seen), 3:gen_sub20(seen),
 4:gen_shapes(seen), 5:gen_numbers(1,100,seen), 6:gen_add_greater(seen),
 7:gen_sub_greater(seen), 8:gen_measurement(seen), 9:gen_time(seen),
 10:gen_money(seen), 11:gen_data(seen), 12:gen_mult_ready(seen),
}
CHTITLE={1:"Numbers up to 50",2:"Addition up to 20",3:"Subtraction within 20",
 4:"Shapes and Patterns",5:"Numbers up to 100",6:"Adding Greater Numbers",
 7:"Subtracting Greater Numbers",8:"Measurement",9:"Time",10:"Money",
 11:"Data",12:"Multiplication Readiness"}
CHPAGE={1:7,2:31,3:54,4:74,5:87,6:105,7:116,8:128,9:141,10:151,11:159,12:164}
MPREFIX={1:"JUN",2:"JUL",3:"JUL",4:"AUG",5:"AUG",6:"SEP",7:"OCT",8:"NOV",9:"DEC",10:"JAN",11:"FEB",12:"MAR"}
for ch,arr in pools.items():
    for i,q in enumerate(arr,1):
        q["id"]=f"{MPREFIX[ch]}-C{ch}-{i:04d}"; q["chapter"]=ch; q["chapterTitle"]=CHTITLE[ch]

MONTHS=[("June",[1]),("July",[2,3]),("August",[4,5]),("September",[6]),("October",[7]),
        ("November",[8]),("December",[9]),("January",[10]),("February",[11]),("March",[12])]

def stratified_revision(prior_by_month, total):
    ms=[m for m in prior_by_month if prior_by_month[m]]
    if not ms: return []
    base=total//len(ms); rem=total%len(ms); rev=[]
    for idx,m in enumerate(ms):
        k=base+(1 if idx<rem else 0); pool=prior_by_month[m]
        rev.extend(random.sample(pool,min(k,len(pool))))
    return rev

# calendar month number for fkmonth (June=6 ... December=12, January=1 ... March=3)
MONTHNUM={"June":6,"July":7,"August":8,"September":9,"October":10,"November":11,
          "December":12,"January":1,"February":2,"March":3}

def build(q,kind,revmonth,monthnum):
    return {
        "id":q["id"],
        "fkboards":FK_BOARDS,           # 1 = CBSE
        "fkgrades":FK_GRADES,           # 1 = Grade 1
        "fksubjects":FK_SUBJECTS,       # 1 = Mathematics
        "academic_year":ACADEMIC_YEAR,  # syllabus year this question belongs to
        "current_month":monthnum,       # calendar month number of the serving month
        "chapter":q["chapter"],
        "chapterTitle":q["chapterTitle"],
        "kind":kind,
        "revisionOfMonth":revmonth,
        "question":q["question"],
        "questionPlain":q["questionPlain"],
        "options":q["options"],
        "answer":q["answer"],
        "explanation":q["explanation"],
    }

months_out=[]; prior_by_month={}
for month,chs in MONTHS:
    mnum=MONTHNUM[month]
    new_qs=[]
    for ch in chs: new_qs.extend(pools[ch])
    revision=stratified_revision(prior_by_month,REV_PER_MONTH)
    rev_breakdown={}
    qlist=[]
    for q in new_qs:
        qlist.append(build(q,"new",None,mnum))
    for q in revision:
        rm=MPREFIX[q["chapter"]]
        rev_breakdown[rm]=rev_breakdown.get(rm,0)+1
        qlist.append(build(q,"revision",rm,mnum))
    random.shuffle(qlist)
    months_out.append({"month":month,"newChapters":chs,"newCount":len(new_qs),
        "revisionCount":len(revision),"revisionFromMonths":rev_breakdown,
        "total":len(qlist),"questions":qlist})
    prior_by_month[month]=new_qs

data={
 "grade":1,"subject":"Mathematics","board":"CBSE / NCF 2023 aligned",
 "source":"maths.docx (Grade 1 Maths textbook, 12 chapters)",
 "academicSession":"June to March","academicYear":ACADEMIC_YEAR,
 "fields":{"id":"unique question id","fkboards":"board foreign key (to be filled by user; currently null)","fkgrades":"grade foreign key (to be filled by user; currently null)","fksubjects":"subject foreign key (to be filled by user; currently null)","academic_year":"syllabus/academic year this question belongs to","current_month":"calendar month number of the serving month (June=6 ... Dec=12, Jan=1, Feb=2, Mar=3)","question":"emoji version for the app UI","questionPlain":"emoji-free text for PDF reports/summaries","options":"4 PDF-safe choices","answer":"correct option","explanation":"parent-friendly reason","kind":"new or revision","revisionOfMonth":"source month if revision"},
 "revisionPolicy":f"Spiral revision: each month contains ALL its new MCQs plus about {REV_PER_MONTH} revision MCQs sampled evenly (stratified) from EVERY previous month. So March includes revision drawn from June through February.",
 "revisionSampleSizePerMonth":REV_PER_MONTH,
 "chapters":[{"number":c,"title":CHTITLE[c],"startPage":CHPAGE[c]} for c in range(1,13)],
 "monthlyPlan":[{"month":m,"chapters":chs} for m,chs in MONTHS],
 "months":months_out
}
json.dump(data,open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"quiz-cbse-grade1-maths.json"),"w",encoding="utf-8"),ensure_ascii=False,indent=1)
print(f"{'MONTH':<11}{'NEW':>7}{'REV':>6}{'TOTAL':>8}  revision-from")
for m in months_out:
    print(f"{m['month']:<11}{m['newCount']:>7}{m['revisionCount']:>6}{m['total']:>8}  {m['revisionFromMonths']}")
print("GRAND NEW (unique):",sum(m['newCount'] for m in months_out))
