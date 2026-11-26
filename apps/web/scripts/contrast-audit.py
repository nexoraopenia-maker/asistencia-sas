def hsl(h,s,l):
    s,l=s/100,l/100; c=(1-abs(2*l-1))*s; x=c*(1-abs((h/60)%2-1)); m=l-c/2
    r,g,b=[(c,x,0),(x,c,0),(0,c,x),(0,x,c),(x,0,c),(c,0,x)][int(h//60)%6]
    return tuple(round((v+m)*255) for v in (r,g,b))
def blend(fg,bg,a): return tuple(round(f*a+b*(1-a)) for f,b in zip(fg,bg))
def lum(rgb):
    def ch(v):
        v/=255; return v/12.92 if v<=0.03928 else ((v+0.055)/1.055)**2.4
    r,g,b=(ch(v) for v in rgb); return .2126*r+.7152*g+.0722*b
def ratio(a,b):
    la,lb=lum(a),lum(b); hi,lo=max(la,lb),min(la,lb); return round((hi+.05)/(lo+.05),2)

# Tokens tal y como quedan en globals.css
LIGHT = {
 "background":(0,0,100),"foreground":(222,47,11),"card":(0,0,100),
 "muted-foreground":(220,9,46),"primary":(243,75,59),"accent":(174,84,26),
 "success-fg":(161,94,24),"success-bg":(160,84,39),
 "warning-fg":(26,90,37),"warning-bg":(38,92,50),
 "danger-fg":(336,78,41),"danger-bg":(350,89,60),
 "info-fg":(243,75,59),"info-bg":(239,84,67),
 "violet-fg":(263,70,50),"violet-bg":(258,90,66),
}
DARK = {
 "background":(222,47,6),"foreground":(210,40,98),"card":(224,44,9),
 "muted-foreground":(215,20,65),"primary":(239,84,67),"accent":(173,80,45),
 "success-fg":(158,64,52),"success-bg":(160,84,39),
 "warning-fg":(43,96,56),"warning-bg":(38,92,50),
 "danger-fg":(351,95,71),"danger-bg":(350,89,60),
 "info-fg":(234,89,74),"info-bg":(239,84,67),
 "violet-fg":(255,92,76),"violet-bg":(258,90,66),
}

fails=[]
print(f"{'':4} {'PAR':44} {'RATIO':>8}  MIN")
print("-"*70)
for theme_name, T in (("claro", LIGHT), ("oscuro", DARK)):
    card = hsl(*T["card"])
    bg = hsl(*T["background"])
    checks = [
      (f"{theme_name} texto principal / fondo", hsl(*T["foreground"]), bg, 4.5),
      (f"{theme_name} texto atenuado / tarjeta", hsl(*T["muted-foreground"]), card, 4.5),
      (f"{theme_name} primario / fondo (UI)", hsl(*T["primary"]), bg, 3.0),
      (f"{theme_name} acento / tarjeta", hsl(*T["accent"]), card, 4.5),
    ]
    for state in ("success","warning","danger","info","violet"):
        tint = blend(hsl(*T[f"{state}-bg"]), card, .10)
        checks.append((f"{theme_name} badge {state} sobre tinte 10%", hsl(*T[f"{state}-fg"]), tint, 4.5))
        border = blend(hsl(*T[f"{state}-bg"]), card, .25)
        checks.append((f"{theme_name} borde {state} / tarjeta (no textual)", border, card, 1.2))
    for label, fg, bgc, need in checks:
        r = ratio(fg, bgc); ok = r >= need
        if not ok: fails.append((label, r, need))
        print(f"{'OK ' if ok else 'X  '} {label:44} {r:>7}:1  {need}")
    print()

total = 26
print(f"{total-len(fails)}/{total} pares cumplen el minimo exigido")
if fails:
    print("\nFALLAN:")
    for l,r,n in fails: print(f"  - {l}: {r}:1 (necesita {n}:1)")
