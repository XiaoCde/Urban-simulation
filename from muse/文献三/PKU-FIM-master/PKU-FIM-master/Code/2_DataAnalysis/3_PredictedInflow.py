# -*-coding:utf-8 -*-
# Linux
# 计算predict的inflow

"""
# @File       : 3_PredictedInflow.py
# @software   : PyCharm  
# @Time       ：2024/6/27 10:25
# @Author     ：Wei Lyu
"""

import numpy as np
import pandas as pd
import pickle

from scipy.ndimage import gaussian_filter
from AgentEnv_Class import Person, Environment

if __name__ == '__main__':
    # path = 'D:/LW/ABM'
    path = '/remote-home/tls/wl/ABM'

    outputPath = path + '/OutputData'

    relation = pd.read_csv(outputPath + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    flow_type = 'inflow'
    sigma = 1
    # for sigma in [0, 1]:

    for city in cities_cn:
        # sigma = 1
        # city = '北京市'
        # basePath = outputPath + '/Result/cities_21_max/' + city
        basePath = outputPath + '/Result_SSP585_pop2/cities_21_max/' + city
        storagePath = basePath + '/sigma=' + str(sigma)

        model_input = pd.read_csv(basePath + '/model_input.csv', header=0)
        fids = model_input[model_input['Tid'] != -2]['FID'].tolist()    # 比arcmap的Fid大1
        tids = model_input[model_input['Tid'] != -2]['Tid'].tolist()
        # del model_input

        # 获取params
        inputParam = pd.read_csv(basePath + '/inputParam.csv', index_col=0, header=None)
        generation = int(inputParam.iloc[0, 0])
        pop_discount = 1 / int(inputParam.iloc[1, 0])
        rows = int(inputParam.iloc[3, 0])
        cols = int(inputParam.iloc[4, 0])

        with open(basePath + '/Sim_env.pkl', 'rb') as file:
            env = pickle.load(file)

        tmp = env.rnd_data[0]
        gen_stab = -1
        for i in range(1, len(env.rnd_data)):
            if (env.rnd_data[i] == tmp).all():
                gen_stab = i - 1  
                break
            else:
                tmp = env.rnd_data[i]
        if gen_stab == -1:
            gen_stab = generation - 1

        del env

        # 提取mask
        mask = np.full((rows, cols), False)  # 记录真值的趋势

        i = 0
        j = rows - 1
        for ind, row in model_input.iterrows():
            if i == cols:
                j -= 1
                i = 0
            tid = row['Tid']
            if tid == -2:
                mask[j, i] = True
            i += 1

        del model_input
        np.save(storagePath + '/' + 'mask.npy', mask)

        # 灾中3天
        flow_pred = np.load(basePath + '/Sim_' + flow_type + '.npy')
        flow_pred = flow_pred[:gen_stab + 1]
        flow_pred = flow_pred / pop_discount 
        flow_pred[0][mask] = np.nan

        flow_pred_sum = np.zeros((gen_stab + 1, rows, cols), dtype=float)
        flow_pred_ave = np.zeros((gen_stab + 1, rows, cols), dtype=float)
        flow_pred_ave[0][mask] = np.nan

        cum_sub_mask = np.full((rows, cols), True)
        for gen in range(1, gen_stab+1):
            sub_mask = ~mask & (flow_pred[gen] == 0)
            cum_sub_mask = cum_sub_mask & sub_mask
            flow_pred[gen] = gaussian_filter(flow_pred[gen], sigma=sigma)
            flow_pred[gen][mask] = np.nan  
            flow_pred[gen][cum_sub_mask] = 0

            flow_pred_sum[gen] = np.sum(flow_pred[:gen+1], axis=0) 
            flow_pred_ave[gen] = flow_pred_sum[gen] / gen

   
        n = len(tids)
        df = pd.DataFrame([[-1] * n, [-1] * n, [-1] * n], dtype=float).T
        df.columns = ['Tid', 'pred_label', 'pred_'+flow_type]
        tmp_id = 0
        k = 1
        for i in range(rows):
            p = rows - 1 - i
            for j in range(cols):
                if k in fids:
                    ind = fids.index(k)
                    tid = tids[ind]
                    df.iloc[tmp_id, 0] = tid
                    df.iloc[tmp_id, 1] = 1 if flow_pred_ave[gen_stab][p, j] > 0 else -1
                    df.iloc[tmp_id, 2] = flow_pred_ave[gen_stab][p, j]
                    tmp_id += 1
                k += 1
        df['Tid'] = df['Tid'].astype(int)
        df['pred_label'] = df['pred_label'].astype(int)

        df.to_csv(storagePath + '/' + flow_type + 'Pred.csv', header=True, index=False, encoding='utf-8')  # 计算matching用
        print(city, 'Done')
