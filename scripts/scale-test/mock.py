import asyncio, json, os, pathlib, resource, time, uuid

state={'started':time.time(),'requests':0,'completed':0,'active':0,'peakActive':0,'bytesIn':0,'bytesOut':0,'errors':0,'samples':[],'config':{}}
deadline=float(os.environ['SCALE_DEADLINE'])

async def send(writer,status,body,ctype='application/json'):
    if not isinstance(body,bytes): body=json.dumps(body).encode()
    writer.write(f'HTTP/1.1 {status} OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode()+body)
    await writer.drain()

async def connection(reader,writer):
    active=False
    try:
        head=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),10)
        line,*headers=head.decode().split('\r\n')
        method,path,_=line.split(' ',2)
        h={a.lower():b.strip() for a,_,b in (x.partition(':') for x in headers if ':' in x)}
        size=int(h.get('content-length','0'))
        if size>20*1024*1024: return await send(writer,413,{'error':'body_limit'})
        body=await reader.readexactly(size) if size else b''
        state['bytesIn']+=len(head)+len(body)
        if path=='/health': return await send(writer,200,{'status':'ok','role':'mock'})
        if path=='/settings':
            if h.get('x-scale-admin')!=os.environ.get('SCALE_ADMIN'): return await send(writer,403,{'error':'denied'})
            config=json.loads(body or b'{}')
            if not 0<float(config.get('duration',0))<=1200 or not 0<float(config.get('rate',0))<=50: return await send(writer,400,{'error':'limits'})
            state['config']=config
            return await send(writer,200,{'configured':True})
        if path=='/stats': return await send(writer,200,{**state,'rssKb':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'cpuSeconds':time.process_time()})
        if path.endswith('/models'): return await send(writer,200,{'object':'list','data':[{'id':'scale-chat','object':'model'},{'id':'scale-codex','object':'model'},{'id':'scale-claude','object':'model'}]})
        if time.time()>=deadline: return await send(writer,410,{'error':'deadline'})
        payload=json.loads(body or b'{}')
        state['requests']+=1
        state['active']+=1
        state['peakActive']=max(state['peakActive'],state['active'])
        active=True
        rid=h.get('x-request-id') or str(uuid.uuid4())
        if len(state['samples'])<30: state['samples'].append({'path':path,'model':payload.get('model'),'requestId':rid,'at':time.time(),'inputBytes':size})
        metadata=payload.get('metadata') or {}
        duration=min(float(state['config'].get('duration',metadata.get('scale_duration',60))),1200)
        rate=min(float(state['config'].get('rate',metadata.get('scale_rate',50))),50)
        if 'quiet' in path: rate=0.1
        if not payload.get('stream'):
            return await send(writer,200,{'id':rid,'object':'chat.completion','model':payload.get('model'),'choices':[{'index':0,'message':{'role':'assistant','content':'x'},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':1,'total_tokens':11}})
        writer.write(f'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nX-Request-Id: {rid}\r\n\r\n'.encode())
        started=time.monotonic()
        count=0
        async def event(data,name=None):
            b=((f'event: {name}\n' if name else '')+'data: '+json.dumps(data,separators=(',',':'))+'\n\n').encode()
            writer.write(b); state['bytesOut']+=len(b); await writer.drain()
        if path.endswith('/responses'):
            response={'id':'resp_'+rid,'object':'response','created_at':int(time.time()),'status':'in_progress','model':payload.get('model'),'output':[]}
            await event({'type':'response.created','response':response},'response.created')
            await event({'type':'response.output_item.added','output_index':0,'item':{'id':'msg_'+rid,'type':'message','role':'assistant','status':'in_progress','content':[]}},'response.output_item.added')
            await event({'type':'response.content_part.added','item_id':'msg_'+rid,'output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},'response.content_part.added')
            while time.monotonic()-started<duration and time.time()<deadline:
                await event({'type':'response.output_text.delta','item_id':'msg_'+rid,'output_index':0,'content_index':0,'delta':'x'},'response.output_text.delta')
                count+=1; await asyncio.sleep(1/rate)
            response.update(status='completed',output=[{'id':'msg_'+rid,'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'x'*count,'annotations':[]}]}],usage={'input_tokens':10,'output_tokens':count,'total_tokens':count+10})
            await event({'type':'response.completed','response':response},'response.completed')
        elif path.endswith('/messages'):
            await event({'type':'message_start','message':{'id':'msg_'+rid,'type':'message','role':'assistant','content':[],'model':payload.get('model'),'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':0}}},'message_start')
            await event({'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}},'content_block_start')
            while time.monotonic()-started<duration and time.time()<deadline:
                await event({'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'x'}},'content_block_delta')
                count+=1; await asyncio.sleep(1/rate)
            await event({'type':'content_block_stop','index':0},'content_block_stop')
            await event({'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':count}},'message_delta')
            await event({'type':'message_stop'},'message_stop')
        else:
            while time.monotonic()-started<duration and time.time()<deadline:
                await event({'id':'chatcmpl-'+rid,'object':'chat.completion.chunk','created':int(time.time()),'model':payload.get('model'),'choices':[{'index':0,'delta':{'content':'x'},'finish_reason':None}]})
                count+=1; await asyncio.sleep(1/rate)
            await event({'id':'chatcmpl-'+rid,'object':'chat.completion.chunk','created':int(time.time()),'model':payload.get('model'),'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':count,'total_tokens':count+10}})
            writer.write(b'data: [DONE]\n\n');state['bytesOut']+=14;await writer.drain()
        state['completed']+=1
    except (ConnectionError,asyncio.IncompleteReadError,asyncio.TimeoutError): state['errors']+=1
    except Exception: state['errors']+=1
    finally:
        if active: state['active']-=1
        writer.close()
        try: await writer.wait_closed()
        except Exception: pass

async def main():
    server=await asyncio.start_server(connection,os.environ.get('SCALE_BIND','0.0.0.0'),int(os.environ.get('SCALE_PORT','8080')),limit=32*1024*1024)
    print('READY',flush=True)
    async with server: await server.serve_forever()
asyncio.run(main())
