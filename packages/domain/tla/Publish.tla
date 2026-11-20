------------------------------ MODULE Publish ------------------------------
(* 发言发布 Compare-And-Publish(需求文档 1.2「单一并发原语」、D15 第二台 P3,AC-10)。           *)
(* 联系人基于读到的会话版本 ver 起草;提交瞬间原子比较 base 与当前 ver,变了就不能发旧稿:      *)
(* UseCAS = FALSE 是「去掉 CAS 版本校验」的变体,必须出反例。                                 *)
(* 对应真实原语:packages/domain/src/cas.ts 的 commitIn(回放见 src/trace-replay.ts)。          *)
EXTENDS Naturals, FiniteSets

CONSTANTS Writers, MaxMsgs, MaxRevise, UseCAS

VARIABLES ver, pc, base, revise, published, msgs, act
vars == <<ver, pc, base, revise, published, msgs, act>>

Init ==
  /\ ver = 0
  /\ pc = [w \in Writers |-> "idle"]
  /\ base = [w \in Writers |-> 0]
  /\ revise = [w \in Writers |-> 0]
  /\ published = {}
  /\ msgs = 0
  /\ act = [op |-> "init"]

UserMsg ==
  /\ msgs < MaxMsgs
  /\ msgs' = msgs + 1
  /\ ver' = ver + 1
  /\ act' = [op |-> "msg", base |-> ver]
  /\ UNCHANGED <<pc, base, revise, published>>

Read(w) ==
  /\ pc[w] = "idle"
  /\ base' = [base EXCEPT ![w] = ver]
  /\ pc' = [pc EXCEPT ![w] = "drafted"]
  /\ act' = [op |-> "read", who |-> w, ver |-> ver]
  /\ UNCHANGED <<ver, revise, published, msgs>>

Publish(w) ==
  /\ pc[w] = "drafted"
  /\ UseCAS => ver = base[w]
  /\ published' = published \cup {[who |-> w, base |-> base[w], over |-> ver]}
  /\ ver' = ver + 1
  /\ pc' = [pc EXCEPT ![w] = "done"]
  /\ act' = [op |-> "publish", who |-> w, base |-> base[w], over |-> ver]
  /\ UNCHANGED <<base, revise, msgs>>

Conflict(w) ==
  /\ UseCAS
  /\ pc[w] = "drafted"
  /\ ver # base[w]
  /\ IF revise[w] < MaxRevise
       THEN /\ pc' = [pc EXCEPT ![w] = "idle"]
            /\ revise' = [revise EXCEPT ![w] = @ + 1]
       ELSE /\ pc' = [pc EXCEPT ![w] = "dropped"]
            /\ UNCHANGED revise
  /\ act' = [op |-> "conflict", who |-> w, base |-> base[w], cur |-> ver]
  /\ UNCHANGED <<ver, base, published, msgs>>

Done ==
  /\ \A w \in Writers : pc[w] \in {"done", "dropped"}
  /\ UNCHANGED vars

Next == UserMsg \/ Done \/ \E w \in Writers : Read(w) \/ Publish(w) \/ Conflict(w)
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK ==
  /\ ver \in Nat
  /\ pc \in [Writers -> {"idle", "drafted", "done", "dropped"}]

NoStalePublish == \A p \in published : p.base = p.over
NoDoubleWrite == \A p, q \in published : p.base = q.base => p = q
Terminates == <>(\A w \in Writers : pc[w] \in {"done", "dropped"})
\* 见证(不是安全性质):取反后让 TLC 给出一条「冲突 → 复核重读 → 成功发布」的真实行为,供回放核对真实实现逐步一致
PublishWitness == ~(\E w \in Writers : revise[w] > 0 /\ pc[w] = "done")
=============================================================================
