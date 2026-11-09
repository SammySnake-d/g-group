------------------------------- MODULE Claim -------------------------------
(* 排他认领 ExclusiveClaim(需求文档 1.2、D20.3 第三台 T1→T2,AC-10)。                        *)
(* 多个联系人读同一任务快照(版本 ver、负责人 owner),本地用任务状态机 apply(Claim) 推导新状态,   *)
(* 再以读到的版本做比较并提交:版本变了收到冲突,重读一次后看到已被认领,状态机拒绝重复认领。     *)
(* UseCAS = FALSE 是「去掉 CAS 版本校验」的变体,必须出反例(两个联系人都以为自己认领成功)。     *)
(* 对应真实原语:cas.ts 的 commit 与 task.ts 的 apply(Claim)(回放见 src/trace-replay.ts)。     *)
EXTENDS Naturals, FiniteSets

CONSTANTS Contacts, UseCAS, NONE

VARIABLES ver, owner, pc, seenVer, seenOwner, retried, winners, act
vars == <<ver, owner, pc, seenVer, seenOwner, retried, winners, act>>

Init ==
  /\ ver = 0
  /\ owner = NONE
  /\ pc = [c \in Contacts |-> "idle"]
  /\ seenVer = [c \in Contacts |-> 0]
  /\ seenOwner = [c \in Contacts |-> NONE]
  /\ retried = [c \in Contacts |-> FALSE]
  /\ winners = {}
  /\ act = [op |-> "init"]

\* 读任务快照
Read(c) ==
  /\ pc[c] = "idle"
  /\ seenVer' = [seenVer EXCEPT ![c] = ver]
  /\ seenOwner' = [seenOwner EXCEPT ![c] = owner]
  /\ pc' = [pc EXCEPT ![c] = "read"]
  /\ act' = [op |-> "read", who |-> c, ver |-> ver]
  /\ UNCHANGED <<ver, owner, retried, winners>>

\* 快照里已有负责人:本地状态机拒绝重复认领
Rejected(c) ==
  /\ pc[c] = "read"
  /\ seenOwner[c] # NONE
  /\ pc' = [pc EXCEPT ![c] = "lost"]
  /\ act' = [op |-> "rejected", who |-> c, ver |-> seenVer[c]]
  /\ UNCHANGED <<ver, owner, seenVer, seenOwner, retried, winners>>

\* 提交点:UseCAS 时原子比较读到的版本与当前版本
Commit(c) ==
  /\ pc[c] = "read"
  /\ seenOwner[c] = NONE
  /\ UseCAS => ver = seenVer[c]
  /\ ver' = ver + 1
  /\ owner' = c
  /\ winners' = winners \cup {c}
  /\ pc' = [pc EXCEPT ![c] = "won"]
  /\ act' = [op |-> "commit", who |-> c, base |-> seenVer[c], over |-> ver]
  /\ UNCHANGED <<seenVer, seenOwner, retried>>

\* 版本已变:收到冲突,重读一次;已重读过就放弃
Conflict(c) ==
  /\ UseCAS
  /\ pc[c] = "read"
  /\ seenOwner[c] = NONE
  /\ ver # seenVer[c]
  /\ IF retried[c]
       THEN /\ pc' = [pc EXCEPT ![c] = "lost"]
            /\ UNCHANGED retried
       ELSE /\ pc' = [pc EXCEPT ![c] = "idle"]
            /\ retried' = [retried EXCEPT ![c] = TRUE]
  /\ act' = [op |-> "conflict", who |-> c, base |-> seenVer[c], cur |-> ver]
  /\ UNCHANGED <<ver, owner, seenVer, seenOwner, winners>>

Done ==
  /\ \A c \in Contacts : pc[c] \in {"won", "lost"}
  /\ UNCHANGED vars

Next == Done \/ \E c \in Contacts : Read(c) \/ Rejected(c) \/ Commit(c) \/ Conflict(c)
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK == pc \in [Contacts -> {"idle", "read", "won", "lost"}]
\* 无双持有:至多一个联系人认领成功
AtMostOneWinner == Cardinality(winners) <= 1
\* 负责人就是唯一的认领成功者
OwnerIsWinner == owner # NONE => winners = {owner}
Terminates == <>(\A c \in Contacts : pc[c] \in {"won", "lost"})
\* 见证(不是安全性质):取反后让 TLC 给出一条「冲突 → 重读 → 状态机拒绝重复认领」的真实行为,供回放核对真实实现逐步一致
ClaimWitness == ~(\E c \in Contacts : retried[c] /\ pc[c] = "lost")
=============================================================================
