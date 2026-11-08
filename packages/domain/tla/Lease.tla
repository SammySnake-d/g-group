------------------------------- MODULE Lease -------------------------------
(* 多资源排他租约(需求文档 D20 第四台 4A R-Quota / 4C R-Worktree / 4D R-Env,C-US14,AC-10)。   *)
(* 每个持有者要申请 Resources 里的全部资源才能开工,用完一次性释放。按资源排他:读到空闲快照后     *)
(* 以快照版本比较并提交(授予时 epoch+1);占用中的资源申请方阻塞等待释放。                       *)
(* Ordered = TRUE:按 (category_rank, res_id) 全序申请(ResSeq 的先后就是全序),查无死锁;          *)
(* Ordered = FALSE 是「去掉全序」的变体,必须出死锁反例;UseCAS = FALSE 是「去掉 CAS 版本校验」     *)
(* 的变体,必须出双持有反例。对应真实原语:src/lease.ts(回放见 src/trace-replay.ts)。             *)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Holders, UseCAS, Ordered, FREE

\* 资源按 (category_rank, res_id) 全序排好:先后就是申请顺序
ResSeq == <<"a", "b", "c">>

Resources == {ResSeq[i] : i \in 1..Len(ResSeq)}
Rank(r) == CHOOSE i \in 1..Len(ResSeq) : ResSeq[i] = r
NoSeen == [res |-> FREE, ver |-> 0]

\* conflicted:提交时收到过冲突的持有者(只用于见证探针,不参与协议)
VARIABLES holder, epoch, ver, held, pc, seen, conflicted, act
vars == <<holder, epoch, ver, held, pc, seen, conflicted, act>>

Init ==
  /\ holder = [r \in Resources |-> FREE]
  /\ epoch = [r \in Resources |-> 0]
  /\ ver = [r \in Resources |-> 0]
  /\ held = [h \in Holders |-> {}]
  /\ pc = [h \in Holders |-> "acquiring"]
  /\ seen = [h \in Holders |-> NoSeen]
  /\ conflicted = {}
  /\ act = [op |-> "init"]

Missing(h) == Resources \ held[h]
\* 下一个可申请的资源:按全序时只能是缺的里面序最小的
Candidates(h) ==
  IF Ordered THEN {r \in Missing(h) : \A s \in Missing(h) : Rank(r) <= Rank(s)}
             ELSE Missing(h)

\* 读资源快照:只在空闲时读到;占用中就阻塞等待释放
Read(h, r) ==
  /\ pc[h] = "acquiring"
  /\ seen[h] = NoSeen
  /\ r \in Candidates(h)
  /\ holder[r] = FREE
  /\ seen' = [seen EXCEPT ![h] = [res |-> r, ver |-> ver[r]]]
  /\ act' = [op |-> "read", who |-> h, res |-> r, ver |-> ver[r]]
  /\ UNCHANGED <<holder, epoch, ver, held, pc, conflicted>>

\* 提交点:UseCAS 时原子比较快照版本;授予时 epoch+1
Grant(h) ==
  /\ pc[h] = "acquiring"
  /\ seen[h] # NoSeen
  /\ LET r == seen[h].res IN
       /\ UseCAS => ver[r] = seen[h].ver
       /\ holder' = [holder EXCEPT ![r] = h]
       /\ epoch' = [epoch EXCEPT ![r] = @ + 1]
       /\ ver' = [ver EXCEPT ![r] = @ + 1]
       /\ held' = [held EXCEPT ![h] = @ \cup {r}]
       /\ pc' = [pc EXCEPT ![h] = IF held[h] \cup {r} = Resources THEN "working" ELSE "acquiring"]
       /\ act' = [op |-> "grant", who |-> h, res |-> r, base |-> seen[h].ver, over |-> ver[r], epoch |-> epoch[r] + 1]
  /\ seen' = [seen EXCEPT ![h] = NoSeen]
  /\ UNCHANGED conflicted

\* 版本已变(别人先拿到了):放下快照,等资源空闲后重读
Conflict(h) ==
  /\ UseCAS
  /\ pc[h] = "acquiring"
  /\ seen[h] # NoSeen
  /\ ver[seen[h].res] # seen[h].ver
  /\ seen' = [seen EXCEPT ![h] = NoSeen]
  /\ conflicted' = conflicted \cup {h}
  /\ act' = [op |-> "conflict", who |-> h, res |-> seen[h].res, base |-> seen[h].ver, cur |-> ver[seen[h].res]]
  /\ UNCHANGED <<holder, epoch, ver, held, pc>>

\* 用完一次性释放全部资源(释放确认之后)
Release(h) ==
  /\ pc[h] = "working"
  /\ holder' = [r \in Resources |-> IF r \in held[h] THEN FREE ELSE holder[r]]
  /\ ver' = [r \in Resources |-> IF r \in held[h] THEN ver[r] + 1 ELSE ver[r]]
  /\ held' = [held EXCEPT ![h] = {}]
  /\ pc' = [pc EXCEPT ![h] = "done"]
  /\ act' = [op |-> "release", who |-> h]
  /\ UNCHANGED <<epoch, seen, conflicted>>

Done ==
  /\ \A h \in Holders : pc[h] = "done"
  /\ UNCHANGED vars

Next == Done \/ \E h \in Holders : Grant(h) \/ Conflict(h) \/ Release(h) \/ \E r \in Resources : Read(h, r)
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK == pc \in [Holders -> {"acquiring", "working", "done"}]
\* 无双持有:每个资源同一时刻至多一个持有者
NoDoubleHold == \A r \in Resources : Cardinality({h \in Holders : r \in held[h]}) <= 1
\* 持有者表与各自持有集合一致
HolderConsistent == \A h \in Holders : \A r \in held[h] : holder[r] = h
\* 不逆序授予:每次授予时,申请方手上没有比它序更高的资源(全序申请的直接后果)
NoReverseGrant == act.op = "grant" => \A s \in held[act.who] : Rank(s) <= Rank(act.res)
Terminates == <>(\A h \in Holders : pc[h] = "done")
\* 见证(不是安全性质):取反后让 TLC 给出一条「后提交者冲突 → 先到者用完释放 → 冲突方重读并拿齐开工」的真实行为,供回放核对真实实现逐步一致
LeaseWitness == ~(\E h \in conflicted : pc[h] = "working")
=============================================================================
