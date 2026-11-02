import json, os, pathlib, resource, time

def text(path):
    try: return pathlib.Path(path).read_text().strip()
    except OSError: return None

def sample():
    processes=[]
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        name=text(p/'comm')
        if name not in ('cliproxy-home','cliproxy-node','python3'): continue
        status=text(p/'status') or ''
        fields={}
        for line in status.splitlines():
            key,_,value=line.partition(':')
            if key in ('VmRSS','VmHWM','Threads'): fields[key]=value.strip()
        try: fields['fds']=len(list((p/'fd').iterdir()))
        except OSError: fields['fds']=None
        processes.append({'pid':int(p.name),'name':name,**fields})
    return {'time':time.time(),'memoryCurrent':text('/sys/fs/cgroup/memory.current'),'memoryPeak':text('/sys/fs/cgroup/memory.peak'),'memoryMax':text('/sys/fs/cgroup/memory.max'),'memoryEvents':text('/sys/fs/cgroup/memory.events'),'cpuStat':text('/sys/fs/cgroup/cpu.stat'),'cpuMax':text('/sys/fs/cgroup/cpu.max'),'netDev':text('/proc/net/dev'),'processes':processes,'selfMaxRss':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}

print(json.dumps(sample()))
